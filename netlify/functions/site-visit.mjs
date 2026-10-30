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
    const id = url.searchParams.get('id');
    if (!validId(id)) return json(400, { error: 'Invalid inspection link.' });
    const report = await db.get(`reports/${id}`, { type: 'json' });
    return report ? json(200, { report }) : json(404, { error: 'Inspection not found.' });
  }

  if (request.method === 'POST') {
    try {
      const { report } = await request.json();
      if (!report || !allowedSites.has(report.site) || !String(report.manager || '').trim()) {
        return json(400, { error: 'Site and manager are required.' });
      }
      const id = randomUUID();
      const saved = {
        ...report,
        id,
        status: 'awaiting-manager',
        createdAt: new Date().toISOString(),
        managerCompletion: null
      };
      if (JSON.stringify(saved).length > 5_000_000) return json(413, { error: 'This report is too large to store. Reduce the number or size of photos.' });
      await db.setJSON(`reports/${id}`, saved);
      return json(201, { id, saved: true });
    } catch {
      return json(400, { error: 'Could not save this inspection.' });
    }
  }

  if (request.method === 'PATCH') {
    const id = url.searchParams.get('id');
    if (!validId(id)) return json(400, { error: 'Invalid inspection link.' });
    try {
      const report = await db.get(`reports/${id}`, { type: 'json' });
      if (!report) return json(404, { error: 'Inspection not found.' });
      if (report.managerCompletion?.completedAt) return json(409, { error: 'Manager follow-up has already been completed.' });
      const { managerCompletion } = await request.json();
      const managerName = String(managerCompletion?.managerName || '').trim().slice(0, 100);
      const updates = managerCompletion?.tasks;
      if (!managerName || !Array.isArray(updates) || updates.length !== (report.managerTasks || []).length) {
        return json(400, { error: 'Manager name and all task updates are required.' });
      }
      const allowedStatuses = new Set(['Open', 'In progress', 'Done']);
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
