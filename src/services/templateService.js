const { templates } = require("bundle-sdk");

const pool = require("../config/database");
const { checksum, customized, decide, optionsFor } = require("./bundleSync");
const { httpError } = require("./contextService");

/*
 * Document templates (DOC-01–09). Versions are never edited in place: a
 * bundle upgrade or a firm's own edit adds a version and makes it current,
 * so a document keeps the exact text it was made from.
 *
 * Upgrades keep a firm's edits (bundleSync.decide): a template the firm has
 * not touched moves to the new bundle text; one the firm edited stays, is
 * flagged update_available_version, and the bundle's newer text is stored
 * beside it as a version that is not current, ready to restore.
 */

/*
 * The fields' order, as the bundle wrote them. JSONB does not keep key
 * order, so a schema read back from Postgres lists its fields in another
 * order; "ui:order" (which the form follows) is recorded when the template
 * arrives, unless the bundle already gave one.
 */
function withOrder(ui, fields) {
  const order = Object.keys(fields?.properties || {});

  if ((ui && ui["ui:order"]) || order.length === 0) return ui || null;

  return { ...(ui || {}), "ui:order": [...order, "*"] };
}

// The part of a template a checksum covers: what the bundle ships.
const content = (template) => {
  const fields = template.fields || template.field_schema || {};

  return {
    name: template.name,
    badge: template.badge || null,
    body: template.body,
    fields,
    ui: withOrder(template.ui, fields),
    enabledWhen: template.enabledWhen || template.enabled_when || null,
  };
};

function checkBody(body, fields) {
  const { errors } = templates.check(body, fields);

  if (errors.length > 0) {
    const error = httpError(400, "The template has problems");
    error.details = { body: errors.join("; ") };
    throw error;
  }
}

async function nextVersion(client, organizationId, key) {
  const result = await client.query("SELECT COALESCE(MAX(version), 0) + 1 AS version FROM document_templates WHERE organization_id = $1 AND key = $2", [organizationId, key]);
  return result.rows[0].version;
}

async function insertVersion(client, organizationId, key, shipped, { bundleKey, source, current, sourceVersion, sourceChecksum, updateAvailable = null, createdBy = null }) {
  if (current) {
    await client.query("UPDATE document_templates SET is_current = false WHERE organization_id = $1 AND key = $2 AND is_current", [organizationId, key]);
  }

  const version = await nextVersion(client, organizationId, key);
  const result = await client.query(
    `INSERT INTO document_templates (organization_id, bundle_key, key, version, name, badge, body, field_schema, ui, enabled_when,
                                     source, is_current, source_version, source_checksum, update_available_version, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     RETURNING *`,
    [organizationId, bundleKey, key, version, shipped.name, shipped.badge, shipped.body, shipped.fields, shipped.ui, shipped.enabledWhen,
      source, current, sourceVersion, sourceChecksum, updateAvailable, createdBy],
  );

  return result.rows[0];
}

// The install step: PUT /documents/bundles/:key/:version.
async function installTemplates(organizationId, bundleKey, version, documents = [], choices = {}) {
  for (const document of documents) {
    if (!document?.key || !document.name || !document.body) {
      throw httpError(400, "Each document needs a key, a name and a body");
    }
    checkBody(document.body, document.fields);
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const summary = { inserted: 0, updated: 0, unchanged: 0, kept: 0, retired: 0, customized: [] };

    for (const document of documents) {
      const shipped = content(document);
      const row = (
        await client.query("SELECT * FROM document_templates WHERE organization_id = $1 AND key = $2 AND is_current", [organizationId, document.key])
      ).rows[0];
      const { action, shippedChecksum, flag, acknowledge } = decide(row && { content: content(row), sourceChecksum: row.source_checksum }, shipped, optionsFor(choices, "document", document.key));
      const options = { bundleKey, source: "bundle", sourceVersion: version, sourceChecksum: shippedChecksum };

      if (action === "insert" || action === "update") {
        await insertVersion(client, organizationId, document.key, shipped, { ...options, current: true });
        summary[action === "insert" ? "inserted" : "updated"] += 1;
        continue;
      }

      if (action === "keep") {
        // The firm's text stays current. Keep the bundle's newer text beside
        // it once, so "restore" has it to restore.
        if (flag) {
          const stored = await client.query(
            "SELECT 1 FROM document_templates WHERE organization_id = $1 AND key = $2 AND source = 'bundle' AND source_checksum = $3",
            [organizationId, document.key, shippedChecksum],
          );

          if (stored.rowCount === 0) {
            await insertVersion(client, organizationId, document.key, shipped, { ...options, current: false });
          }
        }

        await client.query(
          `UPDATE document_templates SET bundle_key = $1, retired_at = NULL,
             update_available_version = CASE WHEN $5 THEN NULL WHEN $2 THEN $3 ELSE update_available_version END,
             source_checksum = CASE WHEN $5 THEN $6 ELSE source_checksum END
           WHERE id = $4`,
          [bundleKey, flag, version, row.id, Boolean(acknowledge), shippedChecksum],
        );
        summary.kept += 1;
        if (flag) summary.customized.push(customized("document", document.key, row.name, content(row), shipped, version));
        continue;
      }

      await client.query(
        `UPDATE document_templates SET bundle_key = $1, source_version = $2, source_checksum = $3, update_available_version = NULL, retired_at = NULL
         WHERE id = $4`,
        [bundleKey, version, shippedChecksum, row.id],
      );
      summary.unchanged += 1;
    }

    const retired = await client.query(
      `UPDATE document_templates SET retired_at = NOW()
       WHERE organization_id = $1 AND bundle_key = $2 AND is_current AND retired_at IS NULL AND key <> ALL($3::text[])`,
      [organizationId, bundleKey, documents.map((document) => document.key)],
    );
    summary.retired = retired.rowCount;

    // A dry run does all the work and rolls it back, to report what it would do.
    await client.query(choices.dryRun ? "ROLLBACK" : "COMMIT");
    return summary;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// Current templates, in the order the bundle installed them.
async function listCurrent(organizationId) {
  const result = await pool.query(
    `SELECT t.*, (SELECT MIN(id) FROM document_templates f WHERE f.organization_id = t.organization_id AND f.key = t.key) AS first_id
     FROM document_templates t
     WHERE t.organization_id = $1 AND t.is_current AND t.retired_at IS NULL
     ORDER BY first_id`,
    [organizationId],
  );
  return result.rows;
}

async function getCurrent(organizationId, key) {
  const row = (await pool.query("SELECT * FROM document_templates WHERE organization_id = $1 AND key = $2 AND is_current", [organizationId, key])).rows[0];
  if (!row) throw httpError(404, "Template not found");
  return row;
}

async function getVersion(organizationId, templateId) {
  const row = (await pool.query("SELECT * FROM document_templates WHERE organization_id = $1 AND id = $2", [organizationId, templateId])).rows[0];
  if (!row) throw httpError(404, "Template not found");
  return row;
}

async function versions(organizationId, key) {
  return (
    await pool.query(
      `SELECT id, version, source, is_current, source_version, created_by, created_at
       FROM document_templates WHERE organization_id = $1 AND key = $2 ORDER BY version DESC`,
      [organizationId, key],
    )
  ).rows;
}

async function audit(client, organizationId, userId, action, key, details) {
  await client.query(
    `INSERT INTO audit_events (organization_id, actor_user_id, action, entity_type, entity_id, details)
     VALUES ($1, $2, $3, 'document_template', $4, $5)`,
    [organizationId, userId, action, key, details],
  );
}

/*
 * A firm's own letter (one no bundle ships): the firm sets its name, the
 * service it is offered for, its fields and its text. Its key starts with
 * "firm_", so a bundle never ships one of the same name, and an install never
 * retires it (it has no bundle_key).
 */
const FIELD_TYPES = {
  text: { schema: { type: "string" } },
  paragraph: { schema: { type: "string" }, ui: { "ui:widget": "textarea" } },
  date: { schema: { type: "string", format: "date" } },
  number: { schema: { type: "number" } },
};
const FIELD_KEY = /^[a-z][a-z0-9_]{0,59}$/;
const MAX_FIELDS = 30;

const firmMade = (template) => !template.bundle_key && template.source === "firm";

function slug(text, length) {
  const value = String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, length).replace(/_+$/, "");
  return /^[0-9]/.test(value) ? `n_${value}`.slice(0, length) : value;
}

// The fields as the form edits them, read back from a stored schema.
function fieldsOf(template) {
  const properties = template.field_schema?.properties || {};
  const order = (template.ui?.["ui:order"] || []).filter((key) => properties[key]);
  const keys = [...order, ...Object.keys(properties).filter((key) => !order.includes(key))];

  return keys.map((key) => {
    const definition = properties[key];
    let type = "text";
    if (definition.type === "number") type = "number";
    else if (definition.format === "date") type = "date";
    else if (template.ui?.[key]?.["ui:widget"] === "textarea") type = "paragraph";
    return { key, title: definition.title || key, type };
  });
}

const serviceOf = (template) => (typeof template.enabled_when?.engaged === "string" ? template.enabled_when.engaged : null);

function ownFields(list) {
  if (list === undefined || list === null) list = [];
  if (!Array.isArray(list)) throw httpError(400, "fields must be a list");
  if (list.length > MAX_FIELDS) throw httpError(400, `A letter can have at most ${MAX_FIELDS} fields`);

  const properties = {};
  const ui = {};

  for (const field of list) {
    const title = typeof field?.title === "string" ? field.title.trim() : "";
    if (!title || title.length > 100) throw httpError(400, "Each field needs a name of up to 100 characters");
    if (!FIELD_TYPES[field.type]) throw httpError(400, `Unknown field type: ${field.type}`);

    // An existing field keeps its key when renamed, so the text still finds it.
    const key = FIELD_KEY.test(String(field.key || "")) ? field.key : slug(title, 60);
    if (!key) throw httpError(400, `The field "${title}" needs a name with letters or numbers`);
    if (properties[key]) throw httpError(400, `Two fields would both be written {{fields.${key}}}; rename one`);

    properties[key] = { ...FIELD_TYPES[field.type].schema, title };
    if (FIELD_TYPES[field.type].ui) ui[key] = FIELD_TYPES[field.type].ui;
  }

  return { schema: Object.keys(properties).length ? { type: "object", properties } : {}, ui: Object.keys(ui).length ? ui : null };
}

// What a firm's own letter holds, checked as a bundle's would be.
async function ownContent(organizationId, { name, service, fields, body }) {
  const title = typeof name === "string" ? name.trim() : "";
  if (!title || title.length > 200) throw httpError(400, "The letter needs a name of up to 200 characters");
  if (typeof body !== "string" || !body.trim()) throw httpError(400, "The template text is required");

  if (service) {
    const known = await pool.query("SELECT 1 FROM services WHERE organization_id = $1 AND key = $2", [organizationId, service]);
    if (known.rowCount === 0) throw httpError(400, "Unknown service");
  }

  const { schema, ui } = ownFields(fields);
  checkBody(body, schema);

  return { name: title, badge: null, body, fields: schema, ui: withOrder(ui, schema), enabledWhen: service ? { engaged: service } : null };
}

// A key no letter of this organization has ever used, retired ones included.
async function freeKey(client, organizationId, name) {
  const base = `firm_${slug(name, 50) || "letter"}`;
  const taken = new Set((await client.query("SELECT DISTINCT key FROM document_templates WHERE organization_id = $1 AND key LIKE $2", [organizationId, `${base}%`])).rows.map((row) => row.key));

  let key = base;
  for (let n = 2; taken.has(key); n += 1) key = `${base}_${n}`;
  return key;
}

async function createTemplate({ organizationId, userId }, input = {}) {
  const shipped = await ownContent(organizationId, input);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const key = await freeKey(client, organizationId, shipped.name);
    const saved = await insertVersion(client, organizationId, key, shipped, { bundleKey: null, source: "firm", current: true, sourceVersion: null, sourceChecksum: null, createdBy: userId });
    await audit(client, organizationId, userId, "document_template.created", key, { version: saved.version, name: saved.name });
    await client.query("COMMIT");
    return saved;
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") throw httpError(409, "Another letter was just added with this name; save again");
    throw error;
  } finally {
    client.release();
  }
}

// Only a firm's own letter can go: a bundle would bring its own back.
async function removeTemplate({ organizationId, userId }, key) {
  const current = await getCurrent(organizationId, key);
  if (!firmMade(current)) throw httpError(409, "A bundle's letter cannot be removed; restore its text instead");

  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query("UPDATE document_templates SET retired_at = NOW() WHERE id = $1 AND retired_at IS NULL", [current.id]);
    await audit(client, organizationId, userId, "document_template.removed", key, { version: current.version, name: current.name });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/*
 * A firm's own revision of a template's text. A bundle letter's fields stay
 * the bundle's; a firm's own letter may change its name, service and fields too.
 */
async function editTemplate({ organizationId, userId }, key, input) {
  const { body } = typeof input === "string" ? { body: input } : input || {};
  if (typeof body !== "string" || !body.trim()) throw httpError(400, "The template text is required");

  const current = await getCurrent(organizationId, key);
  let revised;

  if (firmMade(current)) {
    revised = await ownContent(organizationId, {
      name: input.name ?? current.name,
      service: input.service !== undefined ? input.service : serviceOf(current),
      fields: input.fields ?? fieldsOf(current),
      body,
    });
    if (checksum(revised) === checksum(content(current))) return current;
  } else {
    checkBody(body, current.field_schema);
    if (body === current.body) return current;
    revised = { ...content(current), body };
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const saved = await insertVersion(client, organizationId, key, revised, {
      bundleKey: current.bundle_key,
      source: "firm",
      current: true,
      // Still measured against the bundle text it came from, so an upgrade
      // sees it as the firm's edit and keeps it.
      sourceVersion: current.source_version,
      sourceChecksum: current.source_checksum,
      updateAvailable: current.update_available_version,
      createdBy: userId,
    });
    await audit(client, organizationId, userId, "document_template.edited", key, { version: saved.version });
    await client.query("COMMIT");
    return saved;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// Back to the bundle's text: its latest version becomes current again.
async function restoreTemplate({ organizationId, userId }, key) {
  const current = await getCurrent(organizationId, key);
  const latest = (
    await pool.query(
      "SELECT * FROM document_templates WHERE organization_id = $1 AND key = $2 AND source = 'bundle' ORDER BY version DESC LIMIT 1",
      [organizationId, key],
    )
  ).rows[0];

  if (!latest) throw httpError(404, "This template has no bundle text to restore");
  if (latest.id === current.id) return current;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query("UPDATE document_templates SET is_current = false WHERE organization_id = $1 AND key = $2 AND is_current", [organizationId, key]);
    const restored = (
      await client.query(
        "UPDATE document_templates SET is_current = true, update_available_version = NULL, retired_at = $2 WHERE id = $1 RETURNING *",
        [latest.id, current.retired_at],
      )
    ).rows[0];
    await audit(client, organizationId, userId, "document_template.restored", key, { version: restored.version, from: current.version });
    await client.query("COMMIT");
    return restored;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  installTemplates, listCurrent, getCurrent, getVersion, versions, createTemplate, editTemplate, removeTemplate, restoreTemplate,
  checkBody, content, withOrder, checksum, firmMade, fieldsOf, serviceOf, ownContent, ownFields,
};
