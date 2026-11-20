import { fold } from '@do-it/parser';
import type { Project, Task } from './db';

const STOP = new Set(
  'und oder der die das den dem des ein eine einen einem einer fuer mit von zum zur auf aus bei nach vor ueber unter ist sind noch auch nicht mal bitte heute morgen alle wieder neue neuen neues'.split(
    ' ',
  ),
);

function tokens(title: string): string[] {
  return fold(title)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 3 && !STOP.has(t) && !/^\d+$/.test(t));
}

export interface Model {
  vocab: number;
  projects: Map<string, { docs: number; words: Map<string, number>; total: number }>;
  docs: number;
}

/** Naive-Bayes-Modell aus den eigenen Aufgaben: welche Wörter kommen in welchem Projekt vor? */
export function train(tasks: Task[], projects: Project[]): Model {
  const usable = new Set(projects.filter((p) => !p.isInbox && !p.archived).map((p) => p.id));
  const model: Model = { vocab: 0, projects: new Map(), docs: 0 };
  const vocab = new Set<string>();
  for (const t of tasks) {
    if (!usable.has(t.projectId)) continue;
    let p = model.projects.get(t.projectId);
    if (!p) model.projects.set(t.projectId, (p = { docs: 0, words: new Map(), total: 0 }));
    p.docs++;
    model.docs++;
    for (const w of new Set(tokens(t.title))) {
      p.words.set(w, (p.words.get(w) ?? 0) + 1);
      p.total++;
      vocab.add(w);
    }
  }
  model.vocab = vocab.size;
  return model;
}

/** Projektvorschlag für einen Titel, nur wenn das Modell sich ziemlich sicher ist. */
export function suggest(model: Model, title: string): { projectId: string; confidence: number } | null {
  const words = tokens(title);
  if (!words.length || model.docs < 5) return null;
  const scores: [string, number, boolean][] = [];
  for (const [id, p] of model.projects) {
    if (p.docs < 3) continue;
    let score = Math.log(p.docs / model.docs);
    let known = false;
    for (const w of words) {
      const c = p.words.get(w) ?? 0;
      if (c) known = true;
      score += Math.log((c + 1) / (p.total + model.vocab + 1));
    }
    scores.push([id, score, known]);
  }
  if (!scores.length) return null;
  const max = Math.max(...scores.map((s) => s[1]));
  const sum = scores.reduce((a, s) => a + Math.exp(s[1] - max), 0);
  const best = scores.reduce((a, b) => (b[1] > a[1] ? b : a));
  const confidence = 1 / sum;
  return best[2] && confidence >= 0.7 ? { projectId: best[0], confidence } : null;
}
