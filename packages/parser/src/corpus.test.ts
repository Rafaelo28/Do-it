import { describe, expect, it } from 'vitest';
import { parseMany, parseTask, type ParseContext, type ParseResult } from './index';

/** Freitag, 20.11.2026, 10:00 Uhr */
const ctx: ParseContext = {
  today: '2026-11-20',
  now: '10:00',
  userId: 'u-me',
  members: [
    { id: 'u-me', name: 'Rafael' },
    { id: 'u-anna', name: 'Anna Schmidt' },
    { id: 'u-ben', name: 'Ben' },
  ],
  labels: ['Finanzen'],
  projects: [
    { id: 'inbox', name: 'Eingang', isInbox: true },
    { id: 'p-gesundheit', name: 'Gesundheit' },
    { id: 'p-web', name: 'Website-Relaunch' },
    { id: 'p-garten', name: 'Garten', aliases: ['Rasen'] },
    { id: 'p-haushalt', name: 'Haushalt' },
    { id: 'p-arbeit', name: 'Arbeit' },
    { id: 'p-hausreno', name: 'Haus Renovierung' },
    { id: 'p-haus', name: 'Haus' },
  ],
};

type Expect = Partial<ParseResult>;

const CASES: [string, Expect][] = [
  // --- Datum ---
  ['heute Wäsche waschen', { title: 'Wäsche waschen', dueDate: '2026-11-20', dueTime: null }],
  ['Wäsche waschen heute noch', { title: 'Wäsche waschen', dueDate: '2026-11-20' }],
  ['morgen Bäcker', { title: 'Bäcker', dueDate: '2026-11-21' }],
  ['uebermorgen Oma besuchen', { title: 'Oma besuchen', dueDate: '2026-11-22' }],
  ['Montag Meeting vorbereiten', { title: 'Meeting vorbereiten', dueDate: '2026-11-23' }],
  ['am Freitag Bericht abgeben', { title: 'Bericht abgeben', dueDate: '2026-11-27' }],
  ['diesen Freitag Bericht abgeben', { title: 'Bericht abgeben', dueDate: '2026-11-20' }],
  ['nächsten Freitag Bericht', { title: 'Bericht', dueDate: '2026-11-27' }],
  ['übernächsten Mittwoch Elternabend', { title: 'Elternabend', dueDate: '2026-12-02' }],
  ['Dienstag nächste Woche Zahnarzt', { title: 'Zahnarzt', dueDate: '2026-11-24' }],
  ['nächste Woche Donnerstag Friseur', { title: 'Friseur', dueDate: '2026-11-26' }],
  ['nächste Woche Auto waschen', { title: 'Auto waschen', dueDate: '2026-11-23' }],
  ['Ende nächster Woche Rechnung schreiben', { title: 'Rechnung schreiben', dueDate: '2026-11-27' }],
  ['diese Woche Fenster putzen', { title: 'Fenster putzen', dueDate: '2026-11-20' }],
  ['am Wochenende Keller aufräumen', { title: 'Keller aufräumen', dueDate: '2026-11-21' }],
  ['nächstes Wochenende Ausflug planen', { title: 'Ausflug planen', dueDate: '2026-11-28' }],
  ['in 3 Tagen Paket zurückschicken', { title: 'Paket zurückschicken', dueDate: '2026-11-23' }],
  ['in zwei Wochen Reifen wechseln', { title: 'Reifen wechseln', dueDate: '2026-12-04' }],
  ['in einem Monat Vertrag kündigen', { title: 'Vertrag kündigen', dueDate: '2026-12-20' }],
  ['am 24.12. Geschenke einpacken', { title: 'Geschenke einpacken', dueDate: '2026-12-24' }],
  ['3.1. Steuer', { title: 'Steuer', dueDate: '2027-01-03' }],
  ['15.11. Rückblick', { title: 'Rückblick', dueDate: '2027-11-15' }],
  ['am 5. Dezember Nikolausgeschenke kaufen', { title: 'Nikolausgeschenke kaufen', dueDate: '2026-12-05' }],
  ['1. März 2027 Versicherung', { title: 'Versicherung', dueDate: '2027-03-01' }],
  ['Zahnreinigung 2027-02-03', { title: 'Zahnreinigung', dueDate: '2027-02-03' }],
  ['Ende des Monats Miete prüfen', { title: 'Miete prüfen', dueDate: '2026-11-30' }],
  ['Anfang nächsten Monats Bericht', { title: 'Bericht', dueDate: '2026-12-01' }],
  ['Mitte Dezember Weihnachtsfeier planen', { title: 'Weihnachtsfeier planen', dueDate: '2026-12-15' }],
  ['Ende Januar Steuerunterlagen sortieren', { title: 'Steuerunterlagen sortieren', dueDate: '2027-01-31' }],
  ['Jahresende Inventur', { title: 'Inventur', dueDate: '2026-12-31' }],
  ['an Ostern Eier färben', { title: 'Eier färben', dueDate: '2027-03-28' }],
  ['Muttertag Blumen bestellen', { title: 'Blumen bestellen', dueDate: '2027-05-09' }],
  ['eine Woche nach Ostern Fotos sortieren', { title: 'Fotos sortieren', dueDate: '2027-04-04' }],
  ['am Tag vor Heiligabend Baum kaufen', { title: 'Baum kaufen', dueDate: '2026-12-23' }],
  ['zwei Tage vor Silvester Raclette-Käse kaufen', { title: 'Raclette-Käse kaufen', dueDate: '2026-12-29' }],
  ['1. Advent Kranz basteln', { title: 'Kranz basteln', dueDate: '2026-11-29' }],
  ['KW 50 Urlaub beantragen', { title: 'Urlaub beantragen', dueDate: '2026-12-07' }],
  ['Silvester Raketen kaufen', { title: 'Raketen kaufen', dueDate: '2026-12-31' }],
  ['an Weihnachten Oma anrufen', { title: 'Oma anrufen', dueDate: '2026-12-24' }],
  ['2. Weihnachtsfeiertag Brunch', { title: 'Brunch', dueDate: '2026-12-26' }],
  ['Tag der Deutschen Einheit frei', { title: 'Frei', dueDate: '2027-10-03' }],

  // --- Uhrzeit ---
  ['um 15 Uhr Telefonat mit Bank', { title: 'Telefonat mit Bank', dueDate: '2026-11-20', dueTime: '15:00' }],
  ['Telefonat 9 Uhr', { title: 'Telefonat', dueDate: '2026-11-21', dueTime: '09:00' }],
  ['um 8 Laufen', { title: 'Laufen', dueDate: '2026-11-21', dueTime: '08:00' }],
  ['um 3 Kinder abholen', { title: 'Kinder abholen', dueDate: '2026-11-20', dueTime: '15:00' }],
  ['um 7 abends Essen kochen', { title: 'Essen kochen', dueDate: '2026-11-20', dueTime: '19:00' }],
  ['morgen früh Brötchen holen', { title: 'Brötchen holen', dueDate: '2026-11-21', dueTime: '08:00' }],
  ['heute Abend Serie schauen', { title: 'Serie schauen', dueDate: '2026-11-20', dueTime: '19:00' }],
  ['heute morgen Medikamente', { title: 'Medikamente', dueDate: '2026-11-20', dueTime: '08:00' }],
  ['Montagabend Training', { title: 'Training', dueDate: '2026-11-23', dueTime: '19:00' }],
  ['Montag abends um 8 Training', { title: 'Training', dueDate: '2026-11-23', dueTime: '20:00' }],
  ['viertel nach 4 Zug', { title: 'Zug', dueDate: '2026-11-20', dueTime: '16:15' }],
  ['um halb 8 abends Kino', { title: 'Kino', dueDate: '2026-11-20', dueTime: '19:30' }],
  ['halb 4 Paket abholen', { title: 'Paket abholen', dueDate: '2026-11-20', dueTime: '15:30' }],
  ['zehn vor acht abends Bus', { title: 'Bus', dueDate: '2026-11-20', dueTime: '19:50' }],
  ['von 14 bis 16 Uhr Workshop', { title: 'Workshop', dueDate: '2026-11-20', dueTime: '14:00', durationMin: 120 }],
  ['Meeting 10:30-11:15', { title: 'Meeting', dueDate: '2026-11-20', dueTime: '10:30', durationMin: 45 }],
  ['nach Feierabend einkaufen', { title: 'Einkaufen', dueDate: '2026-11-20', dueTime: '17:00' }],
  ['mittags Pizza bestellen', { title: 'Pizza bestellen', dueDate: '2026-11-20', dueTime: '12:00' }],
  ['15:30 Elterngespräch', { title: 'Elterngespräch', dueDate: '2026-11-20', dueTime: '15:30' }],
  ['morgen um 14:00 Uhr Friseur', { title: 'Friseur', dueDate: '2026-11-21', dueTime: '14:00' }],
  ['Arzt um 11.30', { title: 'Arzt', dueDate: '2026-11-20', dueTime: '11:30' }],

  // --- Wiederholungen ---
  ['jeden Montag Müll rausbringen', { title: 'Müll rausbringen', dueDate: '2026-11-23', recurrence: { freq: 'week', interval: 1, weekdays: [1] } }],
  ['jeden Montag 8 Uhr Müll rausbringen +Ben', { title: 'Müll rausbringen', dueDate: '2026-11-23', dueTime: '08:00', assigneeId: 'u-ben' }],
  ['täglich Vitamine nehmen', { title: 'Vitamine nehmen', dueDate: '2026-11-20', recurrence: { freq: 'day', interval: 1 } }],
  ['jeden Tag um 7 Uhr Zähne putzen', { title: 'Zähne putzen', dueDate: '2026-11-21', dueTime: '07:00' }],
  ['werktags um 9 Stand-up', { title: 'Stand-up', dueDate: '2026-11-23', dueTime: '09:00', recurrence: { freq: 'week', interval: 1, weekdays: [1, 2, 3, 4, 5] } }],
  ['montags und donnerstags Sport', { title: 'Sport', dueDate: '2026-11-23', recurrence: { freq: 'week', interval: 1, weekdays: [1, 4] } }],
  ['jeden Di und Do Gitarre üben', { title: 'Gitarre üben', dueDate: '2026-11-24', recurrence: { freq: 'week', interval: 1, weekdays: [2, 4] } }],
  ['alle 2 Wochen Bettwäsche wechseln', { title: 'Bettwäsche wechseln', dueDate: '2026-11-20', recurrence: { freq: 'week', interval: 2 } }],
  ['alle zwei Wochen am Freitag Teammeeting', { title: 'Teammeeting', dueDate: '2026-11-20', recurrence: { freq: 'week', interval: 2, weekdays: [5] } }],
  ['monatlich am 1. Miete überweisen', { title: 'Miete überweisen', dueDate: '2026-12-01', recurrence: { freq: 'month', interval: 1, monthDay: 1 } }],
  ['jeden 15. Gehalt prüfen', { title: 'Gehalt prüfen', dueDate: '2026-12-15', recurrence: { freq: 'month', interval: 1, monthDay: 15 } }],
  ['jeden letzten Freitag im Monat Teamrunde', { title: 'Teamrunde', dueDate: '2026-11-27', recurrence: { freq: 'month', interval: 1, nthWeekday: { n: -1, weekday: 5 } } }],
  ['jeden ersten Montag im Monat Elternbrief', { title: 'Elternbrief', dueDate: '2026-12-07' }],
  ['vierteljährlich Zählerstand ablesen', { title: 'Zählerstand ablesen', dueDate: '2026-11-20', recurrence: { freq: 'month', interval: 3 } }],
  ['jährlich am 3. Mai Hochzeitstag', { title: 'Hochzeitstag', dueDate: '2027-05-03', recurrence: { freq: 'year', interval: 1, month: 5, monthDay: 3 } }],
  ['jeden 24.12. Geschenke', { title: 'Geschenke', dueDate: '2026-12-24', recurrence: { freq: 'year', interval: 1, month: 12, monthDay: 24 } }],
  ['jeden Abend Tagebuch schreiben', { title: 'Tagebuch schreiben', dueDate: '2026-11-20', dueTime: '19:00', recurrence: { freq: 'day', interval: 1 } }],
  ['sonntagabends Woche planen', { title: 'Woche planen', dueDate: '2026-11-22', dueTime: '19:00' }],
  ['alle 3 Tage nach Erledigung Pflanzen gießen', { title: 'Pflanzen gießen', dueDate: '2026-11-20', recurrence: { freq: 'day', interval: 3, afterCompletion: true } }],
  ['jeden Samstag Bad putzen abwechselnd Anna und Ben', { title: 'Bad putzen', dueDate: '2026-11-21', rotation: ['u-anna', 'u-ben'], assigneeId: 'u-anna' }],
  ['Spülmaschine ausräumen täglich abwechselnd mit Ben', { title: 'Spülmaschine ausräumen', rotation: ['u-me', 'u-ben'], assigneeId: 'u-me' }],
  ['täglich bis 30.11. Antibiotikum nehmen', { title: 'Antibiotikum nehmen', dueDate: '2026-11-20', recurrence: { freq: 'day', interval: 1, until: '2026-11-30' } }],
  ['jeden Montag ab 7.12. Kurs', { title: 'Kurs', dueDate: '2026-12-07' }],
  ['jeden zweiten Montag Supervision', { title: 'Supervision', dueDate: '2026-11-23', recurrence: { freq: 'week', interval: 2, weekdays: [1] } }],
  ['jedes Jahr Steuererklärung', { title: 'Steuererklärung', dueDate: '2026-11-20', recurrence: { freq: 'year', interval: 1 } }],
  ['Fenster putzen werktäglich', { title: 'Fenster putzen' }],

  // --- Erinnerungen ---
  ['Zahnarzt morgen 15 Uhr erinnere mich 30 min vorher', { title: 'Zahnarzt', dueDate: '2026-11-21', dueTime: '15:00', reminders: [{ kind: 'relative', offsetMin: 30 }] }],
  ['übermorgen abend Geschenk für Oma kaufen, erinnere mich 2 Stunden vorher', { title: 'Geschenk für Oma kaufen', dueDate: '2026-11-22', dueTime: '19:00', reminders: [{ kind: 'relative', offsetMin: 120 }] }],
  ['erinnere mich morgen um 9 an den Arzttermin', { title: 'Arzttermin', dueDate: '2026-11-21', dueTime: '09:00', reminders: [{ kind: 'relative', offsetMin: 0 }] }],
  ['Präsentation Montag 14 Uhr, Erinnerung am Vortag', { title: 'Präsentation', dueDate: '2026-11-23', dueTime: '14:00', reminders: [{ kind: 'relative', offsetMin: 1440 }] }],
  ['Flug buchen Freitag, erinnere mich um 18 Uhr', { title: 'Flug buchen', dueDate: '2026-11-27', reminders: [{ kind: 'absolute', date: '2026-11-27', time: '18:00' }] }],
  ['Kuchen backen morgen mit Erinnerung', { title: 'Kuchen backen', dueDate: '2026-11-21', reminders: [{ kind: 'relative', offsetMin: 0 }] }],
  ['1 Tag vorher erinnern Geburtstag Paul 3.12.', { title: 'Geburtstag Paul', dueDate: '2026-12-03', reminders: [{ kind: 'relative', offsetMin: 1440 }] }],
  ['Termin Montag 10 Uhr, Erinnerung: eine halbe Stunde vorher', { title: 'Termin', dueTime: '10:00', reminders: [{ kind: 'relative', offsetMin: 30 }] }],

  // --- Deadline ---
  ['Projektbericht schreiben Deadline 30.11.', { title: 'Projektbericht schreiben', dueDate: null, deadline: '2026-11-30' }],
  ['Steuer machen morgen, Frist: 31.12.', { title: 'Steuer machen', dueDate: '2026-11-21', deadline: '2026-12-31' }],

  // --- Priorität, Labels, Personen, Projekte ---
  ['dringend Mama zurückrufen', { title: 'Mama zurückrufen', priority: 1 }],
  ['Rechnung bezahlen p2 @finanzen', { title: 'Rechnung bezahlen', priority: 2, labels: ['Finanzen'] }],
  ['Wichtig: Versicherung anrufen', { title: 'Versicherung anrufen', priority: 2 }],
  ['Steuer !!! morgen', { title: 'Steuer', priority: 1, dueDate: '2026-11-21' }],
  ['+anna Einkaufsliste schreiben', { title: 'Einkaufsliste schreiben', assigneeId: 'u-anna' }],
  ['Morgen 15 Uhr Zahnarzt anrufen #Gesundheit', { title: 'Zahnarzt anrufen', projectId: 'p-gesundheit', projectVia: 'explicit' }],
  ['Gartenschere schärfen #Haushalt', { title: 'Gartenschere schärfen', projectId: 'p-haushalt' }],
  ['#Website Relaunch Texte schreiben', { title: 'Texte schreiben', projectId: 'p-web' }],
  ['Neues Logo #Marketing', { title: 'Neues Logo', projectId: null, newProjectName: 'Marketing' }],
  ['Rasen mähen', { title: 'Rasen mähen', projectId: 'p-garten', projectVia: 'alias' }],
  ['Angebot für den Website-Relaunch schreiben nächsten Dienstag', { title: 'Angebot für den Website-Relaunch schreiben', projectId: 'p-web', dueDate: '2026-11-24' }],
  ['Fliesen aussuchen für Haus Renovierung', { projectId: 'p-hausreno' }],
  ['nach der Arbeit einkaufen', { title: 'Einkaufen', projectId: null, dueTime: '17:00' }],
  ['Bericht für Arbeit und Garten', { projectId: null, projectSuggestions: ['p-garten', 'p-arbeit'] }],
  ['Termin beim Gesundheitsamt', { projectId: null }],

  // --- Dauer und relative Zeit ---
  ['Klavier üben 30 min', { title: 'Klavier üben', durationMin: 30, dueDate: null }],
  ['eine Stunde joggen', { title: 'Joggen', durationMin: 60 }],
  ['Steuer 1h30', { title: 'Steuer', durationMin: 90 }],
  ['Präsentation üben, dauert 45 Minuten', { title: 'Präsentation üben', durationMin: 45 }],
  ['in 2 Stunden Wäsche aufhängen', { title: 'Wäsche aufhängen', dueDate: '2026-11-20', dueTime: '12:00' }],
  ['in einer halben Stunde Pizza holen', { title: 'Pizza holen', dueTime: '10:30' }],

  // --- Härtefälle ---
  ['übernächste Woche Montag Termin', { title: 'Termin', dueDate: '2026-11-30' }],
  ['bis spätestens Freitag Bericht', { title: 'Bericht', dueDate: null, deadline: '2026-11-27' }],
  ['Bericht schreiben spätestens Freitag', { title: 'Bericht schreiben', dueDate: null, deadline: '2026-11-27' }],
  ['morgen Bericht schreiben, spätestens Freitag', { title: 'Bericht schreiben', dueDate: '2026-11-21', deadline: '2026-11-27' }],
  ['Bericht schreiben, Abgabe Freitag', { title: 'Bericht schreiben', deadline: '2026-11-27' }],
  ['Präsentation Abgabetermin 3.12.', { title: 'Präsentation', deadline: '2026-12-03' }],
  ['Abgabe vorbereiten', { title: 'Abgabe vorbereiten', deadline: null }],
  ['Lernen 2 Stunden lang', { title: 'Lernen', durationMin: 120 }],
  ['Umzug planen für 2 Tage', { title: 'Umzug planen', durationMin: 2880 }],
  ['Messe 3 Tage lang ab Montag', { title: 'Messe', durationMin: 4320, dueDate: '2026-11-23' }],
  ['in 2 Tagen Pakete abholen', { title: 'Pakete abholen', dueDate: '2026-11-22', durationMin: null }],
  ['in der Früh joggen', { title: 'Joggen', dueDate: '2026-11-21', dueTime: '08:00' }],
  ['Morgen um halb neun Arzt', { title: 'Arzt', dueDate: '2026-11-21', dueTime: '08:30' }],
  ['morgen Vormittag Handwerker', { title: 'Handwerker', dueDate: '2026-11-21', dueTime: '10:00' }],
  ['Freitag in einer Woche Party', { title: 'Party', dueDate: '2026-11-27' }],
  ['heute in einer Woche Rechnung prüfen', { title: 'Rechnung prüfen', dueDate: '2026-11-27' }],
  ['29.2. Schaltjahr', { title: 'Schaltjahr', dueDate: '2028-02-29' }],
  ['jeden 31. Miete', { title: 'Miete', dueDate: '2026-11-30', recurrence: { freq: 'month', interval: 1, monthDay: 31 } }],
  ['jeden zweiten Dienstag im Monat Stammtisch', { title: 'Stammtisch', dueDate: '2026-12-08', recurrence: { freq: 'month', interval: 1, nthWeekday: { n: 2, weekday: 2 } } }],
  ['am So. Familie besuchen', { title: 'Familie besuchen', dueDate: '2026-11-22' }],
  ['Geburtstag Mama 12. März jährlich', { title: 'Geburtstag Mama', dueDate: '2027-03-12', recurrence: { freq: 'year', interval: 1 } }],
  ['täglich außer Sonntag Zeitung', { title: 'Zeitung', dueDate: '2026-11-20', recurrence: { freq: 'week', interval: 1, weekdays: [1, 2, 3, 4, 5, 6] } }],
  ['jeden Tag außer am Wochenende Mails', { title: 'Mails', dueDate: '2026-11-20', recurrence: { freq: 'week', interval: 1, weekdays: [1, 2, 3, 4, 5] } }],
  ['erinnere mich in 20 Minuten an den Tee', { title: 'Tee', dueDate: '2026-11-20', dueTime: '10:20', reminders: [{ kind: 'relative', offsetMin: 0 }] }],
  ['Flug nach Berlin am 15.12. um 6:45', { title: 'Flug nach Berlin', dueDate: '2026-12-15', dueTime: '06:45' }],
  ['morgen früh um 7 Bäcker', { title: 'Bäcker', dueDate: '2026-11-21', dueTime: '07:00' }],
  ['heute Abend um 8 Kino', { title: 'Kino', dueDate: '2026-11-20', dueTime: '20:00' }],
  ['Samstag 3 Uhr nachts Sternschnuppen', { title: 'Sternschnuppen', dueDate: '2026-11-21', dueTime: '03:00' }],
  ['Montag, den 30.11. Termin', { title: 'Termin', dueDate: '2026-11-30', warnings: [] }],
  ['Arzttermin am Dienstag, 24.11. um 9:15', { title: 'Arzttermin', dueDate: '2026-11-24', dueTime: '09:15', warnings: [] }],
  ['bis Mitternacht Antrag abschicken', { title: 'Antrag abschicken', dueDate: '2026-11-20', dueTime: '23:59' }],
  ['jedes Jahr zu Weihnachten Plätzchen backen', { title: 'Plätzchen backen', dueDate: '2026-12-24', recurrence: { freq: 'year', interval: 1 } }],
  ['Mitte nächster Woche Bericht', { title: 'Bericht', dueDate: '2026-11-25' }],
  ['nach dem Mittagessen Tabletten', { title: 'Tabletten', dueDate: '2026-11-20', dueTime: '13:00' }],
  ['Freitag nach Feierabend Kino', { title: 'Kino', dueDate: '2026-11-27', dueTime: '17:00' }],
  ['jeden ersten Samstag Flohmarkt', { title: 'Flohmarkt', dueDate: '2026-12-05' }],
  ['Reifenwechsel im Frühjahr', { title: 'Reifenwechsel', dueDate: '2027-03-01' }],
  ['im Winter Skiurlaub buchen', { title: 'Skiurlaub buchen', dueDate: '2026-12-01' }],
  ['heute oder morgen Paket abholen', { title: 'Paket abholen', dueDate: '2026-11-20' }],
  ['am Monatsersten Miete', { title: 'Miete', dueDate: '2026-12-01' }],
  ['nächstes Jahr im März Urlaub buchen', { title: 'Urlaub buchen', dueDate: '2027-03-01', warnings: [] }],
  ['Ende Februar nächsten Jahres Steuer', { title: 'Steuer', dueDate: '2027-02-28' }],
  ['Montag früh Auto in die Werkstatt', { title: 'Auto in die Werkstatt', dueDate: '2026-11-23', dueTime: '08:00' }],
  ['Zahnarzt 2027-01-15 10:30', { title: 'Zahnarzt', dueDate: '2027-01-15', dueTime: '10:30' }],

  // --- Erinnerungen in vielen Formen ---
  ['Zahnarzt morgen 10 Uhr Erinnerung 30 Minuten vorher', { title: 'Zahnarzt', dueTime: '10:00', reminders: [{ kind: 'relative', offsetMin: 30 }] }],
  ['Zahnarzt morgen 10 Uhr erinnere mich 30 min vor dem Termin', { title: 'Zahnarzt', reminders: [{ kind: 'relative', offsetMin: 30 }] }],
  ['Zahnarzt morgen 10 Uhr sag mir 30 Minuten vorher Bescheid', { title: 'Zahnarzt', reminders: [{ kind: 'relative', offsetMin: 30 }] }],
  ['Zahnarzt morgen 10 Uhr, 30 Minuten vorher erinnern lassen', { title: 'Zahnarzt', reminders: [{ kind: 'relative', offsetMin: 30 }] }],
  ['Zahnarzt morgen 10 Uhr Erinnerung 30 Minuten vorher und 1 Tag vorher', { title: 'Zahnarzt', reminders: [{ kind: 'relative', offsetMin: 30 }, { kind: 'relative', offsetMin: 1440 }] }],
  ['Zahnarzt morgen 10 Uhr erinnere mich am Vorabend', { title: 'Zahnarzt', reminders: [{ kind: 'absolute', date: '2026-11-20', time: '19:00' }] }],

  // --- Projekte: .Kurzform und Name allein ---
  ['.Gesundheit Zahnarzt anrufen', { title: 'Zahnarzt anrufen', projectId: 'p-gesundheit', projectVia: 'explicit' }],
  ['Zahnarzt anrufen .gesundheit', { title: 'Zahnarzt anrufen', projectId: 'p-gesundheit', projectVia: 'explicit' }],
  ['.web Texte schreiben', { title: 'Texte schreiben', projectId: 'p-web', projectVia: 'explicit' }],
  ['Arzt anrufen #ges', { title: 'Arzt anrufen', projectId: 'p-gesundheit', newProjectName: null }],
  ['Neues Logo #Marketing-Team', { projectId: null, newProjectName: 'Marketing-Team' }],
  ['.haushalt Fenster putzen', { title: 'Fenster putzen', projectId: 'p-haushalt' }],
  ['.hau Fenster putzen', { projectId: null }],
  ['.NET lernen', { title: '.NET lernen', projectId: null, newProjectName: null }],
  ['Zahnarzt anrufen Gesundheit', { title: 'Zahnarzt anrufen', projectId: 'p-gesundheit' }],
  ['Gesundheit: Zahnarzt anrufen', { title: 'Zahnarzt anrufen', projectId: 'p-gesundheit' }],
  ['Haushalt Fenster putzen morgen', { title: 'Fenster putzen', projectId: 'p-haushalt', dueDate: '2026-11-21' }],
  ['Garten umgraben', { title: 'Garten umgraben', projectId: 'p-garten' }],
  ['Rasen mähen im Garten', { title: 'Rasen mähen im Garten', projectId: 'p-garten' }],
  ['Gartenschere schärfen', { title: 'Gartenschere schärfen', projectId: null, projectSuggestions: ['p-garten'] }],
  ['Arbeitszeugnis anfordern', { projectId: null, projectSuggestions: ['p-arbeit'] }],

  // --- Weitere Datumsformen ---
  ['Steuer bis 24.12', { title: 'Steuer', dueDate: '2026-12-24' }],
  ['Miete am 3.', { title: 'Miete', dueDate: '2026-12-03' }],
  ['bis zum 25. Wichtelgeschenk kaufen', { title: 'Wichtelgeschenk kaufen', dueDate: '2026-11-25' }],
  ['nächsten Monat am 5. Auto zum TÜV', { title: 'Auto zum TÜV', dueDate: '2026-12-05', warnings: [] }],
  ['am 15. des Monats Abrechnung', { title: 'Abrechnung', dueDate: '2026-12-15' }],
  ['um 18h Training', { title: 'Training', dueDate: '2026-11-20', dueTime: '18:00' }],
  ['asap Rückruf Versicherung', { title: 'Rückruf Versicherung', priority: 1 }],

  // --- Keine Fehlalarme ---
  ['Bericht 2.5 schreiben', { title: 'Bericht 2.5 schreiben', dueDate: null }],
  ['iPhone reparieren lassen', { title: 'iPhone reparieren lassen' }],
  ['z.B. Brot kaufen', { title: 'z.B. Brot kaufen' }],
  ['Rechnung 47,50 € bezahlen', { title: 'Rechnung 47,50 € bezahlen', dueDate: null, durationMin: null }],
  ['Zimmer 3.14 streichen', { title: 'Zimmer 3.14 streichen', dueDate: null }],
  ['Frühstück vorbereiten', { title: 'Frühstück vorbereiten', dueTime: null }],
  ['Abendessen kochen', { title: 'Abendessen kochen', dueTime: null }],
  ['Oma an Termin erinnern', { title: 'Oma an Termin erinnern', reminders: [] }],
  ['Buch "Die Morgenröte" lesen', { title: 'Buch "Die Morgenröte" lesen', dueDate: null }],
  ['Guten Morgen sagen', { title: 'Guten Morgen sagen', dueDate: null }],
  ['Sonntagszeitung kaufen', { title: 'Sonntagszeitung kaufen', dueDate: null }],
  ['So schnell wie möglich Auto reparieren', { title: 'Auto reparieren', dueDate: null, priority: 1 }],
  ['Milch, Eier und Brot kaufen', { title: 'Milch, Eier und Brot kaufen', dueDate: null, priority: 4 }],
  ['C++ lernen', { title: 'C++ lernen', assigneeId: null }],
  ['Mail an max@example.com', { title: 'Mail an max@example.com', labels: [] }],
  ['Spieleabend organisieren', { title: 'Spieleabend organisieren', dueTime: null }],
  ['Weihnachtsgeschenke kaufen', { title: 'Weihnachtsgeschenke kaufen', dueDate: null }],
];

describe('Parser-Korpus (Fr, 20.11.2026, 10:00)', () => {
  it.each(CASES)('%s', (input, expected) => {
    const r = parseTask(input, ctx);
    const picked = Object.fromEntries(Object.keys(expected).map((k) => [k, r[k as keyof ParseResult]]));
    if (expected.projectSuggestions) (picked.projectSuggestions as string[]).sort();
    const exp = { ...expected };
    if (exp.projectSuggestions) exp.projectSuggestions = [...exp.projectSuggestions].sort();
    expect(picked).toEqual(exp);
  });
});

describe('Parser-Details', () => {
  it('markiert erkannte Stellen', () => {
    const r = parseTask('Morgen 15 Uhr Zahnarzt anrufen #Gesundheit', ctx);
    expect(r.spans.map((s) => [s.type, s.text])).toEqual([
      ['date', 'Morgen'],
      ['time', '15 Uhr'],
      ['project', '#Gesundheit'],
    ]);
  });

  it('implizite Projekte bleiben im Titel und sind markiert', () => {
    const r = parseTask('Rasen mähen', ctx);
    expect(r.spans).toEqual([{ start: 0, end: 5, type: 'project', text: 'Rasen', implicit: true }]);
  });

  it('Projektnamen mit Emoji oder Zeichen: Kurzform und Abkürzung werden ganz entfernt', () => {
    for (const name of ['🏡 Privat', 'Privat 🏡', '🏠Privat']) {
      const c: ParseContext = { ...ctx, projects: [...ctx.projects!, { id: 'p-privat', name }] };
      for (const input of ['Wäsche waschen .privat', 'Wäsche waschen .priv', '.privat Wäsche waschen', 'Wäsche waschen #privat', 'Wäsche .priv waschen', 'Wäsche waschen priv', 'Wäsche priv waschen', 'priv wäsche waschen']) {
        const r = parseTask(input, c);
        expect([input, name, r.title, r.projectId]).toEqual([input, name, 'Wäsche waschen', 'p-privat']);
      }
    }
    const fam: ParseContext = { ...ctx, projects: [...ctx.projects!, { id: 'p-fam', name: 'Privat & Familie' }] };
    expect(parseTask('Geschenk kaufen #Privat & Familie', fam)).toMatchObject({ title: 'Geschenk kaufen', projectId: 'p-fam' });
    expect(parseTask('Geschenk kaufen .privat', fam)).toMatchObject({ title: 'Geschenk kaufen', projectId: 'p-fam' });
  });

  it('Wortformen eines Projekts bleiben im Satz, Abkürzungen nicht', () => {
    const c: ParseContext = { ...ctx, projects: [...ctx.projects!, { id: 'p-kinder', name: 'Kinder' }, { id: 'p-termine', name: 'Termine' }] };
    // "Kind" ist eine Wortform von "Kinder", kein Kürzel
    expect(parseTask('mit Kind zum Arzt', c)).toMatchObject({ title: 'Mit Kind zum Arzt', projectId: 'p-kinder' });
    expect(parseTask('Termin beim Friseur machen', c)).toMatchObject({ title: 'Termin beim Friseur machen', projectId: 'p-termine' });
    // "Gesu" ist zu kurz für ein Wort-Kürzel, aber ".ges" als Kurzform klappt
    expect(parseTask('Zahnarzt anrufen .ges', ctx)).toMatchObject({ title: 'Zahnarzt anrufen', projectId: 'p-gesundheit' });
  });

  it('ignorierte Stellen bleiben Text', () => {
    const r = parseTask('Freitag Bericht', { ...ctx, ignore: ['freitag'] });
    expect(r.dueDate).toBeNull();
    expect(r.title).toBe('Freitag Bericht');
  });

  it('warnt bei Unverstandenem', () => {
    expect(parseTask('nach dem Urlaub Fotos sortieren', ctx).warnings.length).toBe(1);
    expect(parseTask('Deadline Bericht', ctx).warnings).toContain('Nach „Deadline“ fehlt ein Datum');
    expect(parseTask('Abgabe vorbereiten', ctx).warnings).toEqual([]);
  });

  it('mehrere Zeilen werden mehrere Aufgaben', () => {
    const list = parseMany('- Brot kaufen morgen\n- Zahnarzt anrufen\n\n* Müll 1. Dezember\n1. Steuer', ctx);
    expect(list.map((r) => [r.title, r.dueDate])).toEqual([
      ['Brot kaufen', '2026-11-21'],
      ['Zahnarzt anrufen', null],
      ['Müll', '2026-12-01'],
      ['Steuer', null],
    ]);
  });

  it('ist schnell', () => {
    const start = performance.now();
    for (let i = 0; i < 200; i++) parseTask('jeden Montag 8 Uhr Müll rausbringen +Ben, erinnere mich 10 min vorher #Haushalt', ctx);
    expect((performance.now() - start) / 200).toBeLessThan(5);
  });
});
