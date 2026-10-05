/**
 * us-only.mjs — does a posting limit employment to the United States?
 *
 * The initial rank uses all signals below. The forwarding gate (eval-queue.mjs)
 * and Jev composer (jev-ag-eval.mjs) use the shared benefits matcher.
 *
 * Signals, in the order usOnlySignals reports them:
 *   - US employee benefits in the JD (401(k), disability insurance, FSA, HSA);
 *   - a location that names only US places;
 *   - remote work limited to the US, in the title or the JD;
 *   - US work authorization required with no sponsorship, in the JD.
 *
 * Mixed locations and remote-work lines do not establish those signals; JD
 * benefits are independent.
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import * as yaml from 'js-yaml';

/**
 * US employee benefits. A posting that offers any of them is US employment,
 * even when it says remote: a contractor or EOR hire abroad does not get them.
 * Acronyms match in capitals only, so ordinary words never trip them.
 * $401k, and 401k at the top of a dashed range (250-401k, 180k - 401k), are pay.
 */
const US_ONLY_BENEFITS = [
  ['401(k)', [/\b401\s?\(k\)|(?<!\$)(?<!\d{2,}\s*[-–—]\s*\$?)(?<!\d+k\s*[-–—]\s*\$?)\b401\s?k(?![a-z0-9])/i]],
  ['disability insurance', [/\bdisability insurance\b/i]],
  ['FSA', [/\bFSAs?\b/, /\bflexible spending accounts?\b/i]],
  ['HSA', [/\bHSAs?\b/, /\bhealth savings accounts?\b/i]],
];

/**
 * The US-only benefits a JD text offers, in a fixed order.
 * @param {string} text
 * @returns {string[]}
 */
export function usOnlyBenefits(text) {
  const jd = String(text ?? '');
  return US_ONLY_BENEFITS
    .filter(([, patterns]) => patterns.some(pattern => pattern.test(jd)))
    .map(([label]) => label);
}

const UNITED_STATES = /^(u\.?s\.?(a\.?)?|united states( of america)?)$/i;

/**
 * Does this `authorized_in` list include the United States?
 * @param {unknown} countries
 * @returns {boolean}
 */
export function authorizedInUnitedStates(countries) {
  return Array.isArray(countries) && countries.some(country => UNITED_STATES.test(String(country).trim()));
}

/**
 * Does `location.authorized_in` in config/profile.yml list the United States?
 * @param {string} profilePath
 * @returns {boolean}
 */
export function loadUsAuthorized(profilePath) {
  if (!existsSync(profilePath)) return false;
  const authorized = (yaml.load(readFileSync(profilePath, 'utf-8')) || {}).location?.authorized_in;
  return authorizedInUnitedStates(authorized);
}

/**
 * Text of a `local:` row's JD file under the data root; '' for URL rows, PDFs, and missing files.
 * @param {string} dataRoot
 * @param {string} url
 * @returns {string}
 */
export function readLocalJdText(dataRoot, url) {
  if (!url.startsWith('local:')) return '';
  const path = join(dataRoot, url.slice('local:'.length));
  if (/\.pdf$/i.test(path) || !existsSync(path) || !statSync(path).isFile()) return '';
  return readFileSync(path, 'utf-8');
}

const US_NAME = '(?:US|USA|U\\.S\\.A?|[Uu]nited [Ss]tates(?: of America)?)';
const US_NAME_END = '(?![A-Za-z])';
const US_PLACE_NAME = new RegExp(`^(?:${US_NAME})(?:\\s+Remote)?$`, 'i');

const STATE_ABBREVIATIONS = 'AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC';
// Georgia is left out: bare, it is more often the country.
const STATE_NAMES = 'Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming|District of Columbia';
const US_STATE_ABBREVIATION = new RegExp(`^(?:${STATE_ABBREVIATIONS})$`, 'i');
const US_CITY_STATE = new RegExp(`^[A-Za-z][A-Za-z .'-]*,\\s*(?:${STATE_ABBREVIATIONS})$`, 'i');
const US_STATE_NAME = new RegExp(`^(?:${STATE_NAMES})$`, 'i');

// A scope the candidate can work from. Such a line or location is never US-only.
const OPEN_SCOPE = /\b(?:brazil|brasil|latam|latin america|south america|the americas|worldwide|global(?:ly)?|anywhere|international|any country|all countries)\b/i;
const PLACE_SEPARATOR = new RegExp(`;|·|/|\\||&|[()]|,(?!\\s*(?:${STATE_ABBREVIATIONS})\\b)|\\bor\\b|\\band\\b`, 'i');
const MIXED_US_PLACES = new RegExp(`${US_NAME}${US_NAME_END}\\s*(?:[,/;·|&]|\\b(?:or|and|Or|And|OR|AND)\\b)\\s*[A-Z][A-Za-z-]*(?:\\s+[A-Z][A-Za-z-]*){0,2}`, 'g');

function splitPlaces(text) {
  return text.replace(/^Remote\s*,\s*(?=(?:US|USA|U\.S\.|United States)(?![A-Za-z]))/i, 'Remote - ')
    .replace(/^Remote\s*\(/i, 'Remote - ')
    .split(PLACE_SEPARATOR).map(part => part.trim()).filter(Boolean);
}

function isUsPlace(segment) {
  const place = segment.replace(/^Remote\s*(?:[-–—:]|\b(?:in|within|from)\b)\s*/i, '').trim();
  return US_PLACE_NAME.test(place) || US_STATE_ABBREVIATION.test(place)
    || US_STATE_NAME.test(place) || US_CITY_STATE.test(place);
}

function namesAnotherPlaceWithUs(text) {
  return [...text.matchAll(MIXED_US_PLACES)]
    .some(match => splitPlaces(match[0]).some(segment => !isUsPlace(segment)));
}

/**
 * Does this location name only US places? Segments split on place separators
 * and parentheses; every segment must name the US, a US state, or a `, ST`
 * suffix. A bare `Remote` segment names no place, so it keeps the location open.
 * @param {string} location
 * @returns {boolean}
 */
export function isUsOnlyLocation(location) {
  const text = String(location ?? '').trim();
  if (!text || OPEN_SCOPE.test(text)) return false;
  const segments = splitPlaces(text);
  return segments.length > 0 && segments.every(isUsPlace);
}

const RESTRICTED_REMOTE = [
  new RegExp(`[Rr]emote(?:\\s+(?:role|position|job|work|opportunity))?\\s*(?:[-–—:,(/]|\\b(?:in|within|from)\\b)\\s*\\(?(?:the\\s+)?(?:continental\\s+)?${US_NAME}${US_NAME_END}`),
  new RegExp(`(?<![A-Za-z])${US_NAME}[-\\s]only${US_NAME_END}`),
  new RegExp(`\\b(?:must|need to|required to|has to|have to)\\s+(?:currently\\s+)?(?:be\\s+)?(?:reside|residing|live|living|located|based|resident)\\b[^.\\n]{0,20}?\\b(?:in|within)\\s+(?:the\\s+)?${US_NAME}${US_NAME_END}`, 'i'),
  new RegExp(`\\bopen to (?:candidates|applicants)[^.\\n]{0,30}(?:located|based|residing)\\s+in\\s+(?:the\\s+)?${US_NAME}${US_NAME_END}`, 'i'),
  new RegExp(`(?<![A-Za-z])${US_NAME}\\s+(?:citizens?|citizenship)\\b`),
];

/**
 * Does this text limit remote work to the United States? Checked line by line;
 * a line that also names an open scope does not count.
 * @param {string} text
 * @returns {boolean}
 */
export function limitsRemoteToUnitedStates(text) {
  return String(text ?? '').split('\n')
    .some(line => !OPEN_SCOPE.test(line) && !namesAnotherPlaceWithUs(line)
      && RESTRICTED_REMOTE.some(pattern => pattern.test(line)));
}

const US_WORK_AUTHORIZATION = [
  new RegExp(`\\b(?:authori[sz]ed|eligible|legally\\s+(?:authori[sz]ed|permitted)|legal\\s+right|right)\\s+to\\s+work\\s+(?:legally\\s+)?(?:in|within)\\s+(?:the\\s+)?${US_NAME}${US_NAME_END}`, 'i'),
  new RegExp(`(?<![A-Za-z])${US_NAME}\\s+work\\s+(?:authori[sz]ation|permit)\\b`),
  new RegExp(`\\bwork\\s+authori[sz]ation\\b[^.\\n]{0,40}?${US_NAME}${US_NAME_END}`, 'i'),
];
const NO_SPONSORSHIP = [
  /\b(?:will not|won't|do not|don't|does not|cannot|can't|unable to|not able to|not in a position to|not currently able to|without|no)\b[^.\n]{0,40}\b(?:visa\s+)?sponsor(?:ship|ing)?\b/i,
  /\bsponsorship\b[^.\n]{0,25}\b(?:not|unavailable|no)\b/i,
];
const NON_US_COUNTRIES = 'Canada|Canadian|Mexico|Mexican|Brazil|Brasil|Brazilian|UK|United Kingdom|British|Australia|Australian|Germany|German|France|French|India|Indian';
const NON_US_AUTHORIZATION = [
  new RegExp(`\\b(?:authori[sz]ed to work|eligible to work|work authori[sz]ation|work eligibility|work permit)\\b[^.\\n]{0,40}?\\b(?:in|within)\\s+(?:the\\s+)?(?:${NON_US_COUNTRIES})\\b`, 'i'),
  new RegExp(`\\b(?:${NON_US_COUNTRIES})\\b[^.\\n]{0,40}?\\b(?:work authori[sz]ation|work eligibility|work permit|authori[sz]ed to work|eligible to work)\\b`, 'i'),
];

/**
 * Does the JD require US work authorization and rule out sponsorship?
 * @param {string} text
 * @returns {boolean}
 */
export function requiresUsAuthorizationWithoutSponsorship(text) {
  const jd = String(text ?? '');
  return !namesAnotherPlaceWithUs(jd)
    && !NON_US_AUTHORIZATION.some(pattern => pattern.test(jd))
    && US_WORK_AUTHORIZATION.some(pattern => pattern.test(jd)) && NO_SPONSORSHIP.some(pattern => pattern.test(jd));
}

/**
 * Why a posting is US-only employment, one phrase per signal; [] when none fires.
 * Callers skip this check when the candidate is authorized in the United States.
 * @param {{ title?: string, location?: string, text?: string }} posting
 * @returns {string[]}
 */
export function usOnlySignals({ title = '', location = '', text = '' } = {}) {
  const signals = [];
  const benefits = usOnlyBenefits(text);
  if (benefits.length) signals.push(`the JD offers ${benefits.join(', ')}`);
  if (isUsOnlyLocation(location)) signals.push(`location is US-only (${String(location).trim().slice(0, 50)})`);
  if (limitsRemoteToUnitedStates(title) || limitsRemoteToUnitedStates(text)) {
    signals.push('remote work is limited to the United States');
  }
  if (requiresUsAuthorizationWithoutSponsorship(text)) {
    signals.push('the JD requires US work authorization and offers no sponsorship');
  }
  return signals;
}
