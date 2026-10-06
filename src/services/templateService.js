const { templates } = require("bundle-sdk");

const pool = require("../config/database");
const { decide, checksum } = require("./bundleSync");
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
async function installTemplates(organizationId, bundleKey, version, documents = []) {
  for (const document of documents) {
    if (!document?.key || !document.name || !document.body) {
      throw httpError(400, "Each document needs a key, a name and a body");
    }
    checkBody(document.body, document.fields);
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const summary = { inserted: 0, updated: 0, unchanged: 0, kept: 0, retired: 0 };

    for (const document of documents) {
      const shipped = content(document);
      const row = (
        await client.query("SELECT * FROM document_templates WHERE organization_id = $1 AND key = $2 AND is_current", [organizationId, document.key])
      ).rows[0];
      const { action, shippedChecksum, flag } = decide(row && { content: content(row), sourceChecksum: row.source_checksum }, shipped);
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
             update_available_version = CASE WHEN $2 THEN $3 ELSE update_available_version END
           WHERE id = $4`,
          [bundleKey, flag, version, row.id],
        );
        summary.kept += 1;
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

    await client.query("COMMIT");
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

// A firm's own revision of a template's text. Fields stay the bundle's.
async function editTemplate({ organizationId, userId }, key, body) {
  if (typeof body !== "string" || !body.trim()) throw httpError(400, "The template text is required");

  const current = await getCurrent(organizationId, key);
  checkBody(body, current.field_schema);

  if (body === current.body) return current;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const saved = await insertVersion(client, organizationId, key, { ...content(current), body }, {
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

module.exports = { installTemplates, listCurrent, getCurrent, getVersion, versions, editTemplate, restoreTemplate, checkBody, content, withOrder, checksum };
