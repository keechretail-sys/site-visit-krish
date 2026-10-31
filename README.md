# Site visit Krish

A site inspection tool for Mansfield, Peveril, Lichfield and Brampton. The inspector completes the checklist and finishes the report. Netlify stores it in Blobs and returns a unique manager link. The manager opens the link, updates follow-up actions and signs off.

## Netlify

- Publish directory: `public`
- Functions directory: `netlify/functions`
- Required package: `@netlify/blobs`
- Set the Netlify environment variable `SITE_VISIT_REPORTS_PIN` to a private code of at least 12 characters. This protects the online report list and migration of older browser-only reports. Do not share this code with managers; their unique report links still work without it.
