# document-service

Document service for OmniCore's profession-bundle platform — versioned document templates and the documents generated from them, rendered on the server.

Port 4011; reached through Kong at `/api/documents`. Profession-neutral: what it
stores and how it behaves comes from the organization's installed bundle (see `bundle-sdk`).

Follows the shared service layout: `src/app.js`, `routes/`, `controllers/`, `services/`
(SQL lives there), and the copied `middleware/` (JWT + live access grants,
`requirePermission`). Schema is owned by the `migrations` repo, never by this service.

```bash
npm test && npm run lint
```
