// Разбор субтитров в реплики: SRT, WebVTT, ASS/SSA (поле Name/Actor → персонаж).
import { parseTime } from './util.js';

const clean = s => s.replace(/<[^>]+>/g, '').replace(/\{[^}]*\}/g, '').replace(/\\N/gi, '\n').replace(/\\h/g, ' ').trim();

function parseSrtLike(text) {
  const out = [];
  const blocks = text.replace(/\r/g, '').split(/\n{2,}/);
  for (const b of blocks) {
    const lines = b.split('\n').filter(l => l.trim() !== '');
    const i = lines.findIndex(l => l.includes('-->'));
    if (i < 0) continue;
    const [a, z] = lines[i].split('-->').map(s => s.trim().split(/\s+/)[0]);
    const start = parseTime(a), end = parseTime(z);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    let body = clean(lines.slice(i + 1).join('\n'));
    // «ИМЯ: текст» или WebVTT <v Имя>
    let character = '';
    const v = lines.slice(i + 1).join('\n').match(/<v(?:\.[^ >]*)?\s+([^>]+)>/);
    if (v) character = v[1].trim();
    else {
      const m = body.match(/^([^\n:]{1,30}):\s+(.+)$/s);
      if (m && !/\d$/.test(m[1])) { character = m[1].trim(); body = m[2]; }
    }
    if (body) out.push({ start, end, text: body, character });
  }
  return out;
}

function parseAss(text) {
  const out = [];
  let format = null, inEvents = false;
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    if (/^\[.*\]$/.test(line)) { inEvents = /^\[events\]$/i.test(line); continue; }
    if (!inEvents) continue;
    if (/^format:/i.test(line)) { format = line.slice(7).split(',').map(s => s.trim().toLowerCase()); continue; }
    if (!/^dialogue:/i.test(line) || !format) continue;
    const parts = line.slice(9).trim().split(',');
    const f = {};
    format.forEach((k, i) => { f[k] = i === format.length - 1 ? parts.slice(i).join(',') : parts[i]?.trim(); });
    const start = parseTime(f.start), end = parseTime(f.end);
    const body = clean(f.text || '');
    if (!body || !Number.isFinite(start)) continue;
    // надписи/караоке обычно без имени и с особым стилем — оставляем, но без персонажа
    let character = (f.name || f.actor || '').trim();
    if (!character && f.style && !/^(default|основной|main|top|sign|op|ed)/i.test(f.style)) character = '';
    out.push({ start, end, text: body, character });
  }
  return out;
}

export function parseSubs(name, text) {
  const ext = name.toLowerCase().split('.').pop();
  let cues = ext === 'ass' || ext === 'ssa' || /^\s*\[script info\]/i.test(text) ? parseAss(text) : parseSrtLike(text.replace(/^WEBVTT[^\n]*\n/, ''));
  cues = cues.filter(c => c.end > c.start).sort((a, b) => a.start - b.start);
  // одинаковые подряд реплики (дубли слоёв ASS) — схлопываем
  return cues.filter((c, i) => !(i && cues[i - 1].start === c.start && cues[i - 1].text === c.text));
}
