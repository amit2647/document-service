const { schedules } = require("bundle-sdk");

const pool = require("../config/database");

/*
 * What a document is rendered from (DOC-11): the client, its engagement for
 * the period with the fees summed, the firm and its signing partner, today
 * in the firm's time zone. The names here are exactly the bindings
 * bundle-lint lets a template read (bundle-sdk lint: CLIENT_FIELDS,
 * ENGAGEMENT_FIELDS; templates: BINDING_ROOTS), so a template that lints
 * finds its data.
 *
 * Read straight from the shared database and always scoped by organization,
 * as obligation-service does for the same records.
 */

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

const isoDate = (value) => {
  if (!value) return null;
  if (typeof value === "string") return value.slice(0, 10);
  // pg returns DATE columns as local-midnight Dates; read them back as such.
  const pad = (number) => String(number).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
};

const amount = (value) => (value === null || value === undefined ? 0 : Number(value));

async function loadFirm(organizationId) {
  const organization = (await pool.query("SELECT name, time_zone, currency FROM organizations WHERE id = $1", [organizationId])).rows[0] || {};
  const profile = (await pool.query("SELECT * FROM organization_profiles WHERE organization_id = $1", [organizationId])).rows[0] || {};
  const partner = (
    await pool.query(
      `SELECT name, designation, attributes FROM professionals
       WHERE organization_id = $1 AND status = 'Active'
       ORDER BY is_default_signatory DESC, id LIMIT 1`,
      [organizationId],
    )
  ).rows[0];

  const firmAttributes = profile.attributes || {};

  return {
    timeZone: organization.time_zone || "UTC",
    firm: {
      name: profile.legal_name || organization.name || null,
      address: profile.address || null,
      city: profile.city || null,
      email: profile.email || null,
      phone: profile.phone || null,
      frn: firmAttributes.frn || null,
      currency: organization.currency || "INR",
      attributes: firmAttributes,
    },
    signatory: partner
      ? {
          name: partner.name,
          designation: partner.designation || null,
          membership_no: partner.attributes?.membership_no || null,
          pan: partner.attributes?.pan || null,
          attributes: partner.attributes || {},
        }
      : {},
  };
}

/*
 * The context for one client and period. Throws 404 for a client of another
 * organization. `period` is the engagement period label ("2026-27"); without
 * an engagement for it, the period still comes from the organization's first
 * engagement type, and the engagement is empty.
 */
async function load(organizationId, customerId, period) {
  const client = (
    await pool.query(
      `SELECT id, name, company, email, phone, address, notes, attributes, archived_at, locked_at
       FROM customers WHERE id = $1 AND organization_id = $2`,
      [customerId, organizationId],
    )
  ).rows[0];

  if (!client) throw httpError(404, "Client not found");

  const identifiers = (await pool.query("SELECT type, value FROM customer_identifiers WHERE customer_id = $1", [customerId])).rows;
  const people = (
    await pool.query(
      "SELECT role, name, designation, attributes, is_signatory FROM customer_people WHERE customer_id = $1 ORDER BY position, id",
      [customerId],
    )
  ).rows;

  const engagementRow = period
    ? (
        await pool.query(
          `SELECT e.*, t.key AS type_key, t.name AS type_name, t.period_kind, t.period_start_month
           FROM engagements e JOIN engagement_types t ON t.id = e.engagement_type_id
           WHERE e.customer_id = $1 AND e.organization_id = $2 AND e.period_label = $3 AND e.status <> 'cancelled'
           ORDER BY e.id LIMIT 1`,
          [customerId, organizationId, period],
        )
      ).rows[0]
    : null;

  const lines = engagementRow
    ? (
        await pool.query(
          `SELECT s.key, s.name, l.fee_amount, l.expenses_amount
           FROM engagement_lines l JOIN services s ON s.id = l.service_id
           WHERE l.engagement_id = $1 ORDER BY s.name`,
          [engagementRow.id],
        )
      ).rows
    : [];

  const type =
    engagementRow ||
    (await pool.query("SELECT period_kind, period_start_month FROM engagement_types WHERE organization_id = $1 ORDER BY id LIMIT 1", [organizationId])).rows[0] ||
    {};
  const periodOptions = { periodKind: type.period_kind || "financial_year", periodStartMonth: type.period_start_month || 4 };

  let periodRange = null;
  if (period) {
    try {
      periodRange = schedules.periodFromLabel(period, periodOptions);
    } catch {
      throw httpError(400, `Invalid period: ${period}`);
    }
  }

  const { firm, signatory, timeZone } = await loadFirm(organizationId);
  const signingPerson = people.find((person) => person.is_signatory);

  const context = {
    client: {
      name: client.name,
      company: client.company,
      email: client.email,
      phone: client.phone,
      address: client.address,
      notes: client.notes,
      attributes: client.attributes || {},
      identifiers: Object.fromEntries(identifiers.map((row) => [row.type, row.value])),
      people: people.map(({ role, name, designation, attributes, is_signatory: isSignatory }) => ({ role, name, designation, attributes: attributes || {}, is_signatory: isSignatory })),
      signatory: signingPerson ? { name: signingPerson.name, designation: signingPerson.designation, attributes: signingPerson.attributes || {} } : {},
    },
    engagement: engagementRow
      ? {
          period_label: engagementRow.period_label,
          period_start: isoDate(engagementRow.period_start),
          period_end: isoDate(engagementRow.period_end),
          stage: engagementRow.stage,
          status: engagementRow.status,
          appointment_on: isoDate(engagementRow.appointment_on),
          attributes: engagementRow.attributes || {},
          type: engagementRow.type_name,
          lines: lines.map((line) => ({ service: line.name, key: line.key, fee: amount(line.fee_amount), expenses: amount(line.expenses_amount) })),
          fee_total: lines.reduce((total, line) => total + amount(line.fee_amount), 0),
          expenses_total: lines.reduce((total, line) => total + amount(line.expenses_amount), 0),
          services: lines.map((line) => line.name),
        }
      : { period_label: period || null, attributes: {}, lines: [], services: [] },
    firm,
    signatory,
    today: schedules.todayIn(timeZone),
    period: periodRange ? { label: period, start: periodRange.start, end: periodRange.end } : { label: period || null },
    // For the engaged condition and helper, and the fyStart / fyEnd helpers.
    engaged: lines.map((line) => line.key).filter(Boolean),
    periodStartMonth: periodOptions.periodStartMonth,
  };

  return { context, client, engagementId: engagementRow?.id || null, serviceNames: Object.fromEntries(lines.map((line) => [line.key, line.name])) };
}

module.exports = { load, loadFirm, isoDate, httpError };
