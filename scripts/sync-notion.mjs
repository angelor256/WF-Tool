// Pulls the CS roster + last-90-days tardiness/absence records from Notion
// and writes them to data/employees.json and data/logs.json.
// Run by .github/workflows/sync-notion.yml on a schedule (or manually).
//
// Requires env var NOTION_TOKEN (a Notion internal integration token that
// has been shared with the "CS - Tardies and Absences" page in Notion).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const NOTION_TOKEN = process.env.NOTION_TOKEN;
if (!NOTION_TOKEN) {
  console.error('Missing NOTION_TOKEN env var.');
  process.exit(1);
}

// Data source IDs (not page/database IDs) — see README_NOTION_SYNC.md for
// how to find these if you ever point this at a different Notion page.
const ROSTER_DS = '34cc3eae-24e8-81f9-99ac-000bc2060cd6';   // "CS 2026" roster
const TARDIES_DS = 'bebbb6ba-d03d-45a0-930f-e02d2b45700d';  // "Tardies and Absences Record"

const DAYS_BACK = 90;
const OUT_DIR = path.join(process.cwd(), 'data');

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2025-09-03';

async function queryDataSource(dsId, body) {
  const results = [];
  let cursor = undefined;
  do {
    const res = await fetch(`${NOTION_API}/data_sources/${dsId}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ...body, ...(cursor ? { start_cursor: cursor } : {}), page_size: 100 }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Notion API error ${res.status} on ${dsId}: ${text}`);
    }
    const json = await res.json();
    results.push(...json.results);
    cursor = json.has_more ? json.next_cursor : null;
  } while (cursor);
  return results;
}

function titleOf(page, propName) {
  const prop = page.properties[propName];
  if (!prop) return '';
  if (prop.type === 'title') return prop.title.map(t => t.plain_text).join('').trim();
  return '';
}
function selectOf(page, propName) {
  const prop = page.properties[propName];
  return prop && prop.select ? prop.select.name : null;
}
function dateOf(page, propName) {
  const prop = page.properties[propName];
  return prop && prop.date ? prop.date.start : null;
}
function relationIds(page, propName) {
  const prop = page.properties[propName];
  return prop && prop.relation ? prop.relation.map(r => r.id) : [];
}

// Costa Rican legal-name convention on this roster: "SURNAME1 SURNAME2 FIRSTNAME(S)".
// A handful of foreign names only have one surname and will come out in a
// slightly odd order — edit those by hand in the app's Directorio if so.
function normalizeName(raw) {
  const parts = raw.trim().split(/\s+/).map(w => w.charAt(0) + w.slice(1).toLowerCase());
  if (parts.length >= 3) {
    return `${parts.slice(2).join(' ')} ${parts.slice(0, 2).join(' ')}`.trim();
  } else if (parts.length === 2) {
    return `${parts[1]} ${parts[0]}`.trim();
  }
  return parts.join(' ');
}

function slug(id) {
  return 'ntn_' + id.replace(/-/g, '');
}

async function loadPreviousEmployees() {
  try {
    const raw = await readFile(path.join(OUT_DIR, 'employees.json'), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

const TYPE_MAP = {
  'Tardy (less than 5 mins)': ['tardanza', 'Tardanza <5 min (Notion)'],
  'Tardy (more than 5 mins)': ['tardanza', 'Tardanza >5 min (Notion)'],
  'Unjustified Absence': ['ausencia', 'Ausencia injustificada (Notion)'],
  'Justified Absence': ['ausencia', 'Ausencia justificada (Notion)'],
  'Medical Leave CCSS/INS': ['nota', 'Incapacidad CCSS/INS (Notion)'],
  'Medical Leave Private Doctor': ['nota', 'Incapacidad medico privado (Notion)'],
  'Medical Leave Company Doctor': ['nota', 'Incapacidad medico empresa (Notion)'],
  'Paternity Leave': ['nota', 'Permiso de paternidad (Notion)'],
  'Maternity Leave': ['nota', 'Permiso de maternidad (Notion)'],
  'Schedule non-compliance': ['nota', 'Incumplimiento de horario (Notion)'],
};

async function main() {
  console.log('Querying Notion roster...');
  const rosterPages = await queryDataSource(ROSTER_DS, {});
  console.log(`Roster: ${rosterPages.length} pages`);

  const rosterById = new Map();
  for (const p of rosterPages) {
    rosterById.set(p.id, {
      name: normalizeName(titleOf(p, 'Nombre') || 'Desconocido'),
      dept: selectOf(p, 'Departamento') || '?',
      puesto: selectOf(p, 'Puesto Descripción') || '?',
      estado: selectOf(p, 'Estado') || '?',
    });
  }

  const cutoff = new Date(Date.now() - DAYS_BACK * 86400000).toISOString().slice(0, 10);
  console.log(`Querying tardies/absences since ${cutoff}...`);
  const tardyPages = await queryDataSource(TARDIES_DS, {
    filter: { property: 'Date', date: { on_or_after: cutoff } },
    sorts: [{ property: 'Date', direction: 'ascending' }],
  });
  console.log(`Tardies/absences: ${tardyPages.length} records`);

  const previousEmployees = await loadPreviousEmployees();
  const prevByName = new Map(previousEmployees.map(e => [e.name.toLowerCase(), e]));

  const usedNotionIds = new Set();
  for (const t of tardyPages) {
    for (const id of relationIds(t, 'EMPLOYEE')) usedNotionIds.add(id);
  }
  // Also include everyone currently active in CS, even with no recent record.
  for (const [id, info] of rosterById) {
    if (info.estado === 'ACT' && info.dept === 'CS') usedNotionIds.add(id);
  }

  const employees = [];
  const idMap = new Map(); // notion page id -> our employee id
  for (const notionId of usedNotionIds) {
    const info = rosterById.get(notionId);
    const name = info ? info.name : notionId;
    const prev = prevByName.get(name.toLowerCase());
    const eid = prev ? prev.id : slug(notionId);
    idMap.set(notionId, eid);
    const team = prev ? prev.team
      : (info && info.estado === 'ACT' && info.dept === 'CS') ? 'Sin equipo asignado'
      : (info ? info.dept : '?');
    employees.push({
      id: eid,
      name,
      team,
      group: prev ? prev.group : '',
      channel: prev ? prev.channel : 'N/A',
      vacDays: prev ? prev.vacDays : 12,
      notes: prev ? prev.notes : (info ? `Puesto Softland: ${info.puesto}` : ''),
    });
  }
  employees.sort((a, b) => a.name.localeCompare(b.name));

  const logs = [];
  for (const t of tardyPages) {
    const type = selectOf(t, 'Type');
    const mapped = TYPE_MAP[type];
    if (!mapped) continue; // unknown type, skip rather than guess
    const [logType, detail] = mapped;
    const date = dateOf(t, 'Date');
    for (const empNotionId of relationIds(t, 'EMPLOYEE')) {
      const eid = idMap.get(empNotionId);
      if (!eid) continue;
      logs.push({
        id: 'ntn_' + t.id.replace(/-/g, '') + '_' + empNotionId.slice(0, 6),
        employeeId: eid,
        date,
        type: logType,
        detail,
        days: null,
      });
    }
  }
  logs.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, 'employees.json'), JSON.stringify(employees, null, 1));
  await writeFile(path.join(OUT_DIR, 'logs.json'), JSON.stringify(logs, null, 1));
  await writeFile(path.join(OUT_DIR, 'last_sync.json'), JSON.stringify({
    syncedAt: new Date().toISOString(),
    employees: employees.length,
    logs: logs.length,
    windowDays: DAYS_BACK,
  }, null, 1));

  console.log(`Wrote ${employees.length} employees and ${logs.length} log entries.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
