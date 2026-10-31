import { randomUUID } from 'node:crypto';
import { getStore } from '@netlify/blobs';

const store = () => getStore('site-visit-reports');
const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  }
});
const validId = id => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id);
const allowedSites = new Set(['Mansfield', 'Peveril', 'Lichfield', 'Brampton']);


export default async request => {
  const db = store();
  const url = new URL(request.url);

  if (request.method === 'GET') {
    if (url.searchParams.get('list') === '1') {
      try {
        const { blobs } = await db.list({ prefix: 'reports/' });
        const stored = await Promise.all(blobs.map(blob => db.get(blob.key, { type: 'json' })));
        const reports = stored.filter(Boolean).map(report => ({
          id: report.id, site: report.site, manager: report.manager, inspector: report.inspector,
          date: report.date, createdAt: report.createdAt, counts: report.counts, issues: report.issues,
          status: report.status, managerCompletion: report.managerCompletion
        })).sort((a, b) => new Date(b.date || b.createdAt || 0) - new Date(a.date || a.createdAt || 0));
        return json(200, { reports });
      } catch {
        return json(500, { error: 'Could not load online reports.' });
      }
    }
    const id = url.searchParams.get('id');
    if (!validId(id)) return json(400, { error: 'Invalid inspection link.' });
    const report = await db.get(`reports/${id}`, { type: 'json' });
    return report ? json(200, { report }) : json(404, { error: 'Inspection not found.' });
  }

  if (request.method === 'POST') {
    try {
      const { report, importLocal = false } = await request.json();
      if (!report || !allowedSites.has(report.site) || !String(report.manager || '').trim()) {
        return json(400, { error: 'Site and manager are required.' });
      }
      const id = randomUUID();
      const sourceId = importLocal ? String(report.id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 100) : '';
      const importKey = sourceId ? `imports/${sourceId}` : '';
      if (importKey) {
        const existingId = await db.get(importKey, { type: 'text' });
        if (existingId) return json(200, { id: existingId, saved: true, imported: true });
      }
      const saved = {
        ...report,
        id,
        ...(sourceId ? { importedFromLocalId: sourceId } : {}),
        status: 'awaiting-manager',
        createdAt: new Date().toISOString(),
        managerCompletion: null
      };
      if (JSON.stringify(saved).length > 5_000_000) return json(413, { error: 'This report is too large to store. Reduce the number or size of photos.' });
      await db.setJSON(`reports/${id}`, saved);
      if (importKey) await db.set(importKey, id);
      return json(importLocal ? 200 : 201, { id, saved: true, imported: Boolean(importLocal) });
    } catch {
      return json(400, { error: 'Could not save this inspection.' });
    }
  }

  if (request.method === 'DELETE') {
    const id = url.searchParams.get('id');
    if (!validId(id)) return json(400, { error: 'Invalid report.' });
    const expectedPin = process.env.SITE_VISIT_REPORTS_PIN || '';
    if (!expectedPin) return json(503, { error: 'Report deletion is not configured. Add SITE_VISIT_REPORTS_PIN in Netlify.' });
    let body;
    try { body = await request.json(); } catch { return json(400, { error: 'Enter the reports access code.' }); }
    if (String(body.pin || '') !== expectedPin) return json(401, { error: 'The reports access code is incorrect.' });
    try {
      const key = `reports/${id}`;
      const report = await db.get(key, { type: 'json' });
      if (!report) return json(404, { error: 'Report not found.' });
      await db.delete(key);
      if (report.importedFromLocalId) {
        const sourceId = String(report.importedFromLocalId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 100);
        if (sourceId) await db.delete(`imports/${sourceId}`);
      }
      return json(200, { deleted: true });
    } catch {
      return json(500, { error: 'Could not delete this report.' });
    }
  }

  if (request.method === 'PATCH') {
    const id = url.searchParams.get('id');
    if (!validId(id)) return json(400, { error: 'Invalid inspection link.' });
    try {
      const report = await db.get(`reports/${id}`, { type: 'json' });
      if (!report) return json(404, { error: 'Inspection not found.' });
      if (report.managerCompletion?.completedAt) return json(409, { error: 'Manager follow-up has already been completed.' });
      const body = await request.json();
      const allowedStatuses = new Set(['Open', 'In progress', 'Done']);
      if (body.taskUpdate) {
        const { index, status, managerNote } = body.taskUpdate;
        if (!Number.isInteger(index) || index < 0 || index >= (report.managerTasks || []).length || !allowedStatuses.has(status)) {
          return json(400, { error: 'Invalid task update.' });
        }
        const currentTask = report.managerTasks[index];
        report.managerTasks[index] = {
          ...currentTask,
          status,
          managerNote: String(managerNote || '').trim().slice(0, 2000),
          savedAt: new Date().toISOString()
        };
        report.status = 'manager-in-progress';
        await db.setJSON(`reports/${id}`, report);
        return json(200, { saved: true, report });
      }
      const { managerCompletion } = body;
      const managerName = String(managerCompletion?.managerName || '').trim().slice(0, 100);
      const updates = managerCompletion?.tasks;
      if (!managerName || !Array.isArray(updates) || updates.length !== (report.managerTasks || []).length) {
        return json(400, { error: 'Manager name and all task updates are required.' });
      }
      const tasks = report.managerTasks.map((task, index) => {
        const update = updates[index] || {};
        if (!allowedStatuses.has(update.status)) throw new Error('Invalid task status');
        const managerNote = String(update.managerNote || '').trim().slice(0, 2000);
        if (update.status !== 'Done' && !managerNote) throw new Error('Add an update for each unfinished task');
        return { ...task, status: update.status, managerNote };
      });
      report.managerTasks = tasks;
      report.managerCompletion = {
        managerName,
        note: String(managerCompletion.note || '').trim().slice(0, 4000),
        completedAt: new Date().toISOString()
      };
      report.status = 'manager-completed';
      await db.setJSON(`reports/${id}`, report);
      return json(200, { saved: true, report });
    } catch (error) {
      return json(400, { error: error.message === 'Add an update for each unfinished task' ? error.message : 'Could not save manager follow-up.' });
    }
  }

  return json(405, { error: 'Method not allowed.' });
};
