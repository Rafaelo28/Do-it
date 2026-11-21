/**
 * Ende-zu-Ende-Test im echten Browser (Chromium über Playwright).
 * Voraussetzung: Server läuft mit LEERER Datenbank und gebauter Web-App, z. B.
 *   pnpm build && DATABASE_URL=… SETUP_CODE=E2E-CODE-1 RUN_WORKER=true node apps/server/dist/main.js
 * Aufruf: E2E_URL=http://localhost:8080 node e2e/app.e2e.mjs [screenshot-ordner]
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const URL_ = process.env.E2E_URL ?? 'http://localhost:8080';
const SHOTS = process.argv[2];
const SETUP_CODE = process.env.E2E_SETUP_CODE ?? 'E2E-CODE-1';
const step = (msg) => console.log(`✓ ${msg}`);

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const errors = [];
async function device(opts = {}) {
  const ctx = await browser.newContext({ timezoneId: 'Europe/Berlin', locale: 'de-DE', ...opts });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  return { ctx, page };
}
const quickAdd = (page) => page.getByRole('textbox', { name: 'Neue Aufgabe' }).first();
async function add(page, text) {
  await quickAdd(page).fill(text);
  await quickAdd(page).press('Enter');
}

try {
  // ---------- Anna richtet ein ----------
  const anna = await device({ viewport: { width: 1280, height: 860 } });
  await anna.page.goto(URL_);
  await anna.page.getByLabel('Name').fill('Anna');
  await anna.page.getByLabel('E-Mail').fill('anna@example.org');
  await anna.page.getByLabel('Passwort').fill('geheim1234');
  await anna.page.getByLabel('Einrichtungscode').fill('FALSCH-00');
  await anna.page.getByRole('button', { name: 'Konto anlegen' }).click();
  await anna.page.getByText('Einrichtungscode falsch').waitFor();
  await anna.page.getByLabel('Einrichtungscode').fill(SETUP_CODE);
  await anna.page.getByRole('button', { name: 'Konto anlegen' }).click();
  await anna.page.getByRole('heading', { name: 'Heute' }).waitFor();
  step('Ersteinrichtung nur mit Einrichtungscode');

  // Projekt per Sidebar anlegen und Aufgabe darin
  await anna.page.getByRole('button', { name: 'Projekt anlegen' }).click();
  await anna.page.getByPlaceholder('Projektname').fill('Haushalt');
  await anna.page.getByPlaceholder('Projektname').press('Enter');
  await anna.page.getByRole('heading', { name: 'Haushalt' }).waitFor();
  await add(anna.page, 'Bad putzen jeden Samstag');
  await anna.page.getByText('Bad putzen').waitFor();
  step('Projekt und wiederkehrende Aufgabe');

  // Einladungslink fürs Projekt
  await anna.page.getByRole('button', { name: 'Projekt-Einstellungen' }).click();
  await anna.page.getByRole('button', { name: 'Link erstellen' }).click();
  const inviteUrl = await anna.page.locator('input[readonly]').inputValue();
  assert.match(inviteUrl, /\/invite\//);
  await anna.page.getByRole('button', { name: 'Schließen' }).click();
  step('Einladungslink erstellt');

  // ---------- Ben registriert sich über den Link (Handy) ----------
  const ben = await device({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await ben.page.goto(inviteUrl.replace(/^https?:\/\/[^/]+/, URL_));
  await ben.page.getByText('lädt dich ein').waitFor();
  await ben.page.getByLabel('Name').fill('Ben');
  await ben.page.getByLabel('E-Mail').fill('ben@example.org');
  await ben.page.getByLabel('Passwort').fill('ben-geheim-42');
  await ben.page.getByRole('button', { name: 'Konto anlegen' }).click();
  await ben.page.getByRole('heading', { name: 'Heute' }).waitFor();
  await ben.page.getByRole('button', { name: 'Menü' }).click();
  await ben.page.getByRole('link', { name: /Haushalt/ }).click();
  await ben.page.getByText('Bad putzen').waitFor();
  step('Ben ist über den Link im geteilten Projekt');

  // ---------- Anna weist Ben etwas zu, Ben sieht es live ----------
  await anna.page.reload();
  await anna.page.getByRole('heading', { name: 'Haushalt' }).waitFor();
  await anna.page.waitForTimeout(800);
  await add(anna.page, 'Müll rausbringen morgen +Ben');
  await ben.page.getByText('Müll rausbringen').waitFor({ timeout: 8000 });
  step('Live-Sync über WebSocket mit Zuweisung');

  // ---------- Ben arbeitet offline ----------
  await ben.ctx.setOffline(true);
  await ben.page.waitForTimeout(300);
  await add(ben.page, 'Glühbirne wechseln heute');
  await ben.page.getByText('Glühbirne wechseln').waitFor();
  await ben.page.locator('li.task', { hasText: 'Bad putzen' }).getByRole('button', { name: 'Erledigt' }).click();
  await ben.page.waitForTimeout(500);
  assert.equal(await anna.page.getByText('Glühbirne wechseln').count(), 0, 'darf erst nach dem Online-Gehen ankommen');
  // App startet auch komplett ohne Netz (Service Worker + lokale Daten)
  await ben.page.reload();
  await ben.page.getByText('Glühbirne wechseln').waitFor({ timeout: 8000 });
  step('Offline: anlegen, abhaken, App neu laden ohne Netz');
  await ben.ctx.setOffline(false);
  await anna.page.getByText('Glühbirne wechseln').waitFor({ timeout: 15000 });
  step('Nach dem Online-Gehen bei Anna angekommen');

  // Wiederkehrende Aufgabe: nach dem Abhaken bei Anna mit neuem Datum, nicht erledigt
  await anna.page.waitForTimeout(500);
  const bad = anna.page.locator('li.task', { hasText: 'Bad putzen' });
  assert.equal(await bad.count(), 1, 'wiederkehrende Aufgabe bleibt sichtbar');
  step('Wiederkehrende Aufgabe springt weiter');

  // Sortieren per Ziehen (Maus): "Glühbirne wechseln" ganz nach oben
  const from = anna.page.locator('li.task', { hasText: 'Glühbirne wechseln' });
  await from.hover();
  const h = await from.locator('.drag-handle').boundingBox();
  const top = await anna.page.locator('li.task').first().boundingBox();
  await anna.page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await anna.page.mouse.down();
  await anna.page.mouse.move(top.x + 80, top.y + 4, { steps: 8 });
  await anna.page.mouse.up();
  await anna.page.waitForTimeout(400);
  assert.equal((await anna.page.locator('li.task .task-title').first().textContent())?.trim(), 'Glühbirne wechseln');
  await anna.page.reload();
  await anna.page.getByRole('heading', { name: 'Haushalt' }).waitFor();
  await anna.page.locator('li.task').first().waitFor();
  assert.equal((await anna.page.locator('li.task .task-title').first().textContent())?.trim(), 'Glühbirne wechseln');
  step('Sortieren per Ziehen bleibt nach dem Neuladen');

  // ---------- Erledigt-Übersicht ----------
  await anna.page.locator('li.task', { hasText: 'Müll rausbringen' }).getByRole('button', { name: 'Erledigt' }).click();
  await anna.page.getByRole('link', { name: 'Erledigt' }).click();
  await anna.page.getByRole('heading', { name: 'Erledigt' }).waitFor();
  const doneMuell = anna.page.locator('li.done-item', { hasText: 'Müll rausbringen' });
  await doneMuell.waitFor({ timeout: 8000 });
  const doneBad = anna.page.locator('li.done-item', { hasText: 'Bad putzen' });
  await doneBad.waitFor();
  assert.match(await doneBad.textContent(), /von Ben/);
  assert.match(await doneBad.textContent(), /wiederkehrend/);
  await doneMuell.getByRole('button', { name: 'Wieder öffnen' }).click();
  await doneMuell.getByText('wieder offen').waitFor();
  await anna.page.getByRole('link', { name: /Haushalt/ }).click();
  await anna.page.locator('li.task', { hasText: 'Müll rausbringen' }).waitFor();
  step('Erledigt-Übersicht mit Wieder-öffnen');

  if (SHOTS) {
    await anna.page.screenshot({ path: `${SHOTS}/e2e-anna.png` });
    await ben.page.screenshot({ path: `${SHOTS}/e2e-ben.png` });
    await anna.page.goto(`${URL_}/settings`);
    await anna.page.getByRole('heading', { name: 'Einstellungen' }).waitFor();
    await anna.page.screenshot({ path: `${SHOTS}/e2e-settings.png`, fullPage: true });
  }
  assert.deepEqual(errors, [], `Fehler im Browser: ${errors.join(' | ')}`);
  console.log('\nAlle E2E-Schritte erfolgreich.');
} finally {
  await browser.close();
}
