#!/usr/bin/env node

/**
 * scan-hn.mjs — Hacker News scanner with Optional AI Enhancement.
 * Following the "Zero-Keys" architecture: 
 * 1. Deterministic fetch via HN Provider API.
 * 2. Optional AI-layer if GEMINI_API_KEY is present.
 * 3. Fallback to keyword-matching if no key is present.
 */

try {
  const { config } = await import('dotenv');
  config(); 
} catch (e) {}

import { readFileSync, existsSync } from 'fs';
import * as yaml from 'js-yaml';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { isJevEnabled, jevChoice, jevNoul } from './lib/jev-client.mjs';
import { appendToPipeline, appendToScanHistory, loadSeenUrls, PORTALS_PATH } from './scan.mjs';
import { localToday } from './lib/local-today.mjs';

// Import the deterministic provider
import hnProvider from './providers/hackernews.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { printScanSummaryHeader } from './lib/scan-summary-marker.mjs';

// ── Configuration ────────────────────────────────────────────────────
// Imported from scan.mjs so it honors CAREER_OPS_PORTALS and the data root (#3510).

function loadKeywords() {
  const defaultKeywords = ["Software Engineer"];
  let configObj = {};
  if (existsSync(PORTALS_PATH)) {
    try {
      configObj = yaml.load(readFileSync(PORTALS_PATH, 'utf-8')) || {};
    } catch (e) {}
  }
  return configObj.hn_hiring?.keywords || defaultKeywords;
}

// ── AI Extraction Layer ─────────────────────────────────────────
export async function extractWithAI(rawText, model) {
  const prompt = `--- BEGIN UNTRUSTED DATA ---\n${rawText.substring(0, 2000)}\n--- END UNTRUSTED DATA ---`;
  try {
    const result = await model.generateContent(prompt);
    const response = result.response.text();
    const clean = response.replace(/```yaml|```/g, '').trim();

    let parsed;
    try {
      parsed = yaml.load(clean);
    } catch {
      return null; // Always return null on parse errors
    }

    if (!parsed || typeof parsed !== 'object') return null;
    return {
      company: (parsed.company || parsed.COMPANY || '').trim(),
      title: (parsed.title || parsed.TITLE || '').trim(),
      location: (parsed.location || parsed.LOCATION || 'Remote/Unknown').trim()
    };
  } catch {
    return null;
  }
}

// ── Jev Extraction Layer (opt-in via TYPESAFE_API_KEY) ──────────────────
//
// Takes priority over the Gemini/keyword branches below when enabled, but
// changes nothing when TYPESAFE_API_KEY is unset: extractWithAI() and the
// keyword `.includes` fallback are untouched, and main() only reaches this
// path when isJevEnabled() is true.

const DEFAULT_JEV_CONFIDENCE_THRESHOLD = 0.6;

function resolveConfidenceThreshold(raw) {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : DEFAULT_JEV_CONFIDENCE_THRESHOLD;
}

const JEV_LISTING_INSTRUCTIONS = 'Whether `text` is an actual individual HN "Who is hiring" job listing ' +
  '(a company naming a specific role it is hiring for), as opposed to a reply, question, or meta commentary ' +
  'about the hiring thread itself.';

/**
 * Jev-backed replacement for the ad-hoc Gemini-YAML extraction: a Noul asks
 * whether `text` is a real job listing at all, then a Choice picks which of
 * the user's configured keyword archetypes (if any) it matches. Returns null
 * — letting the caller fall back to its own logic — when Jev is disabled, a
 * question errors, or either answer's confidence is below `threshold`.
 *
 * @param {string} text - Untrusted HN post title + body.
 * @param {string[]} keywords - The user's configured hn_hiring.keywords archetypes.
 * @param {{ confidenceThreshold?: number }} [opts]
 * @returns {Promise<{ archetype: string, confidence: number } | null>}
 */
export async function extractWithJev(text, keywords, { confidenceThreshold } = {}) {
  if (!isJevEnabled() || typeof text !== 'string' || !text.trim() || !Array.isArray(keywords) || keywords.length === 0) {
    return null;
  }
  const threshold = resolveConfidenceThreshold(confidenceThreshold ?? process.env.JEV_HN_CONFIDENCE_THRESHOLD);

  const noul = await jevNoul({
    state: text,
    instructions: JEV_LISTING_INSTRUCTIONS,
    whenTrue: 'The text names a company and a specific role it is hiring for.',
    whenFalse: 'The text is a reply, question, or meta commentary with no listing of its own.',
    id: 'is-listing',
  });
  if (noul.probability === null || noul.probability < threshold) return null;

  const options = {};
  for (const kw of keywords) options[kw] = `The listing is hiring for a role matching "${kw}".`;
  options.none = 'The listing does not match any of the target archetypes.';
  options.maybe = 'The listing might match a target archetype, but it is genuinely unclear which one.';

  const choice = await jevChoice({
    state: text,
    instructions: 'Which target archetype (if any) this job listing matches.',
    options,
    id: 'archetype',
  });
  if (choice.choice === null || choice.confidence < threshold || choice.choice === 'none' || choice.choice === 'maybe') {
    return null;
  }
  return { archetype: choice.choice, confidence: Math.min(noul.probability, choice.confidence) };
}

// ── Main Logic ───────────────────────────────────────────────────────

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  const myKeywords = loadKeywords();
  const { seen } = loadSeenUrls();

  console.log(`🔍 Fetching latest HN Hiring data...`);
  
  const ctx = { fetchJson: async (url) => (await fetch(url)).json() };
  const rawJobs = await hnProvider.fetch({ name: 'HN' }, ctx);

  const newOffers = [];

  // STEP 2: The Architecture Branch. Jev takes priority when enabled (see
  // extractWithJev's doc comment); the Gemini and keyword branches below are
  // byte-for-byte unchanged and are exactly what runs when TYPESAFE_API_KEY
  // is unset.
  if (isJevEnabled()) {
    console.log(`✨ Jev enabled. Classifying via TypeSafe...`);
    for (const job of rawJobs) {
      if (seen.has(job.url)) continue;

      const match = await extractWithJev(job.title + " " + (job.text || ""), myKeywords);
      if (match) {
        newOffers.push({ ...job, source: 'hn-hiring', postedAt: Date.now(), jevArchetype: match.archetype });
        console.log(`  ✅ Jev match (${match.archetype}): ${job.title}`);
      }
      seen.add(job.url);
    }
  } else if (apiKey) {
    console.log(`✨ AI Key detected. Processing with Gemini...`);
    const modelName = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: modelName,
      systemInstruction: `Extract job data. Match: [${myKeywords.join(', ')}]. Format: YAML (company, title, location).`,
    });

    for (const job of rawJobs) {
      if (seen.has(job.url)) continue;
      
      const extracted = await extractWithAI(job.title + " " + (job.text || ""), model);
      if (extracted && extracted.company && extracted.title) {
        newOffers.push({ ...job, ...extracted, source: 'hn-hiring', postedAt: Date.now() });
        console.log(`  ✅ AI Match: ${extracted.company}`);
      }
      seen.add(job.url);
    }
  } else {
    // STEP 3: Fallback Mode (Deterministic/No-Key)
    console.log(`⚠️ No AI key. Using keyword filtering mode...`);
    for (const job of rawJobs) {
      if (seen.has(job.url)) continue;

      const matches = myKeywords.some(k => job.title.toLowerCase().includes(k.toLowerCase()));
      if (matches) {
        newOffers.push({ ...job, source: 'hn-hiring', postedAt: Date.now() });
        console.log(`  ✅ Match: ${job.company}`);
      }
      seen.add(job.url);
    }
  }

  if (newOffers.length > 0) {
    await appendToPipeline(newOffers);
    await appendToScanHistory(newOffers, localToday(), 'added');
  }

  // Printed on every run, including the zero-match one. This scanner used to
  // end in silence when nothing matched, which reads identically to a run that
  // died at the fetch — the summary is what tells those apart (#3560).
  printScanSummaryHeader('HN Scan', localToday());
  console.log(`Postings fetched:   ${rawJobs.length}`);
  console.log(`New offers:         ${newOffers.length}`);
  if (newOffers.length > 0) console.log(`\n🎉 Success: ${newOffers.length} offers added.`);
}

if (isMainModule(import.meta.url)) {
  main().catch(err => { console.error("Fatal:", err.message); process.exit(1); });
}