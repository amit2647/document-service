const { conditions, profiles, templates } = require("bundle-sdk");

const pool = require("../config/database");
const contextService = require("./contextService");
const templateService = require("./templateService");

const { httpError } = contextService;

/*
 * Generated documents (DOC-09–15, CD-12): the tiles a client's period offers,
 * a preview that stores nothing, drafts, and finalized letters. A document is
 * always rendered from the template version it was started with, and a
 * finalized one keeps the HTML it rendered, so later template versions never
 * change a letter already issued.
 */

const PLACEHOLDER = /<mark class="doc-placeholder">\[([^\]]*)\]<\/mark>/g;

// A missing field shows its title, not its key (DOC-12).
function labelsFor(template) {
  const properties = template.field_schema?.properties || {};
  return Object.fromEntries(Object.entries(properties).map(([field, definition]) => [`fields.${field}`, definition.title || field]));
}

function missingIn(html) {
  return [...new Set([...html.matchAll(PLACEHOLDER)].map((match) => match[1]))];
}

function render(template, context, fieldValues, body = template.body) {
  const fields = { ...templates.prefill(template.ui, context), ...(fieldValues || {}) };
  const html = templates.render(body, { ...context, fields }, { labels: labelsFor(template) });

  return { html, fields, missing: missingIn(html) };
}

// Why a template is off for this client and period, in words (DOC-09).
function reasonFor(condition, serviceNames) {
  if (condition && typeof condition === "object") {
    if (typeof condition.engaged === "string") {
      return `Needs ${serviceNames[condition.engaged] || condition.engaged.replace(/_/g, " ")} engaged for this year`;
    }

    const filled = condition.filled?.var;
    if (typeof filled === "string") {
      return `Needs ${filled.split(".").filter((part) => !["client", "engagement", "attributes"].includes(part)).join(" ").replace(/_/g, " ")} filled in`;
    }
  }

  return "Not applicable for this year";
}

const fieldDefinitions = (template) => ({ fields: template.field_schema || {}, ui: template.ui || null });

async function tiles(organizationId, customerId, period) {
  const current = await templateService.listCurrent(organizationId);
  let loaded = null;

  if (customerId) {
    loaded = await contextService.load(organizationId, customerId, period);
  }

  // Names for "Needs <service> engaged": every service the bundle catalogs.
  const catalog = Object.fromEntries((await pool.query("SELECT key, name FROM services WHERE organization_id = $1 AND key IS NOT NULL", [organizationId])).rows.map((row) => [row.key, row.name]));

  return current.map((template) => {
    const enabled = !loaded || !template.enabled_when || Boolean(conditions.evaluate(template.enabled_when, loaded.context));

    return {
      key: template.key,
      name: template.name,
      badge: template.badge,
      version: template.version,
      source: template.source,
      customized: template.source === "firm",
      updateAvailable: template.update_available_version,
      enabled,
      reason: enabled ? null : reasonFor(template.enabled_when, catalog),
      // What the letter depends on, whatever the client: the services its
      // condition names (a service's Letters tab), and the condition in words.
      services: template.enabled_when ? conditions.validate(template.enabled_when, "enabledWhen").services : [],
      needs: template.enabled_when ? reasonFor(template.enabled_when, catalog) : null,
    };
  });
}

async function templateDetail(organizationId, key) {
  const template = await templateService.getCurrent(organizationId, key);

  return {
    key: template.key,
    name: template.name,
    badge: template.badge,
    version: template.version,
    source: template.source,
    customized: template.source === "firm",
    updateAvailable: template.update_available_version,
    body: template.body,
    ...fieldDefinitions(template),
    versions: await templateService.versions(organizationId, key),
  };
}

/*
 * Nothing stored. `body` previews an unsaved edit of the template text (the
 * template editor); it is checked exactly as a save would check it.
 */
async function preview(organizationId, { templateKey, customerId, period, fieldValues, body }) {
  const template = await templateService.getCurrent(organizationId, templateKey);

  if (body !== undefined) templateService.checkBody(body, template.field_schema);

  const context = customerId
    ? (await contextService.load(organizationId, customerId, period)).context
    : { client: {}, engagement: {}, ...(await contextService.loadFirm(organizationId)), today: null, period: { label: period || null }, engaged: [] };
  const rendered = render(template, context, fieldValues, body ?? template.body);

  return {
    html: rendered.html,
    missing: rendered.missing,
    values: rendered.fields,
    name: template.name,
    badge: template.badge,
    firm: context.firm,
    signatory: context.signatory,
    ...fieldDefinitions(template),
  };
}

const summaryColumns = `id, customer_id, engagement_id, template_key, template_version, period_label, title, status, udin,
  finalized_at, finalized_by, created_by, created_at, updated_at`;

async function list(organizationId, { customerId, period }) {
  if (!customerId) throw httpError(400, "customerId is required");

  const values = [organizationId, customerId];
  let where = "organization_id = $1 AND customer_id = $2";

  if (period) {
    values.push(period);
    where += ` AND period_label = $${values.length}`;
  }

  return (await pool.query(`SELECT ${summaryColumns} FROM generated_documents WHERE ${where} ORDER BY created_at DESC, id DESC`, values)).rows;
}

async function load(organizationId, documentId) {
  const row = (await pool.query("SELECT * FROM generated_documents WHERE id = $1 AND organization_id = $2", [documentId, organizationId])).rows[0];
  if (!row) throw httpError(404, "Document not found");
  return row;
}

async function get(organizationId, documentId) {
  const document = await load(organizationId, documentId);
  const template = await templateService.getVersion(organizationId, document.template_id);
  const { firm, signatory } = await contextService.loadFirm(organizationId);

  return {
    ...document,
    templateName: template.name,
    badge: template.badge,
    missing: missingIn(document.rendered_html),
    firm,
    signatory,
    ...fieldDefinitions(template),
  };
}

function writable(client) {
  if (client.archived_at) throw httpError(409, "This client is archived; its documents are read-only");
}

async function create({ organizationId, userId }, { templateKey, customerId, period, fieldValues }) {
  if (!templateKey || !customerId) throw httpError(400, "templateKey and customerId are required");

  const template = await templateService.getCurrent(organizationId, templateKey);
  const { context, client, engagementId } = await contextService.load(organizationId, customerId, period);
  writable(client);

  if (template.enabled_when && !conditions.evaluate(template.enabled_when, context)) {
    throw httpError(409, `${template.name} does not apply to this client for ${period || "this period"}`);
  }

  const rendered = render(template, context, fieldValues);
  const result = await pool.query(
    `INSERT INTO generated_documents (organization_id, customer_id, engagement_id, template_id, template_key, template_version, period_label,
                                      title, field_values, rendered_html, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [organizationId, customerId, engagementId, template.id, template.key, template.version, period || null,
      period ? `${template.name} · FY ${period}` : template.name, rendered.fields, rendered.html, userId],
  );

  return get(organizationId, result.rows[0].id);
}

// A draft's fields change; it is re-rendered from its own template version.
async function update({ organizationId }, documentId, { fieldValues }) {
  const document = await load(organizationId, documentId);
  if (document.status === "final") throw httpError(409, "A finalized document cannot be changed");

  const template = await templateService.getVersion(organizationId, document.template_id);
  const { context, client } = await contextService.load(organizationId, document.customer_id, document.period_label);
  writable(client);

  const rendered = render(template, context, fieldValues ?? document.field_values);
  await pool.query("UPDATE generated_documents SET field_values = $1, rendered_html = $2, updated_at = NOW() WHERE id = $3", [rendered.fields, rendered.html, documentId]);

  return get(organizationId, documentId);
}

/*
 * Freezes a draft: rendered once more and kept as it is from then on. Refused
 * while the fields fail their schema or a value is still missing, so no
 * issued letter carries a [placeholder].
 */
async function finalize({ organizationId, userId }, documentId, { udin } = {}) {
  const document = await load(organizationId, documentId);
  if (document.status === "final") throw httpError(409, "This document is already finalized");

  const template = await templateService.getVersion(organizationId, document.template_id);
  const { context, client } = await contextService.load(organizationId, document.customer_id, document.period_label);
  writable(client);

  const checked = profiles.validate(template.field_schema || {}, document.field_values || {});
  if (!checked.valid) {
    const error = httpError(400, "Some fields need attention before this can be finalized");
    error.details = checked.errors;
    throw error;
  }

  const rendered = render(template, context, document.field_values);
  if (rendered.missing.length > 0) {
    const error = httpError(409, `Still missing: ${rendered.missing.join(", ")}`);
    error.details = { missing: rendered.missing };
    throw error;
  }

  if (udin !== undefined && udin !== null && udin !== "" && !/^[0-9A-Z]{18}$/.test(String(udin))) {
    const error = httpError(400, "A UDIN is 18 letters and digits");
    error.details = { udin: "A UDIN is 18 letters and digits" };
    throw error;
  }

  const db = await pool.connect();

  try {
    await db.query("BEGIN");
    await db.query(
      `UPDATE generated_documents SET status = 'final', rendered_html = $1, udin = $2, finalized_at = NOW(), finalized_by = $3, updated_at = NOW()
       WHERE id = $4`,
      [rendered.html, udin || null, userId, documentId],
    );
    await db.query(
      `INSERT INTO audit_events (organization_id, actor_user_id, action, entity_type, entity_id, customer_id, details)
       VALUES ($1, $2, 'document.finalized', 'document', $3, $4, $5)`,
      [organizationId, userId, String(documentId), document.customer_id, { template: template.key, version: template.version, period: document.period_label, udin: udin || null }],
    );
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }

  return get(organizationId, documentId);
}

async function remove({ organizationId }, documentId) {
  const document = await load(organizationId, documentId);
  if (document.status === "final") throw httpError(409, "A finalized document is kept as issued");

  await pool.query("DELETE FROM generated_documents WHERE id = $1", [documentId]);
  return { deleted: true };
}

module.exports = { tiles, templateDetail, preview, list, get, create, update, finalize, remove, render, reasonFor, missingIn };
