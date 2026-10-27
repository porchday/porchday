/** Builds the dark stylesheet from the light stylesheets. The Vite config
 * serves it as `virtual:dark.css` in dev and build, so it is never stale.
 *
 * Every declaration that sets a color is repeated under
 * `:where([data-color-scheme="dark"])`, which adds no specificity, so the
 * mirrored rules keep the light cascade's relative order and win only because
 * the dark stylesheet loads last. Colors keep their hue while their perceptual (OKLab)
 * lightness is remapped by role: text becomes light, surfaces dark. Shadows,
 * the member-chosen site backdrop and SVG data are left unchanged. */
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

export const SOURCES = ['styles.css', 'retro.css'];
const SCOPE = ':where([data-color-scheme="dark"])';

/** Hand-tuned rules appended after the generated mirror. */
const OVERRIDES = `
:root[data-color-scheme="dark"] {
  color-scheme: dark;
}
:root[data-color-scheme="light"] {
  color-scheme: light;
}
/* The fixed-color logo image needs more light against dark surfaces. */
:where([data-color-scheme="dark"]) .logo-mark {
  filter: brightness(1.45) saturate(0.85);
}
/* The clean backdrop is chosen in JavaScript; the patterned ones are already dark. */
:root[data-color-scheme="dark"][data-site-background="clean"] {
  background-color: #1b1612;
}
`;

type Node = {kind: 'rule'; selector: string; body: string} | {kind: 'block'; prelude: string; children: Node[]} | {kind: 'other'; text: string};

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Minimal parser for the plain CSS used here: rules, nested at-rule blocks and statements. */
function parse(css: string): Node[] {
  let index = 0;
  const parseList = (): Node[] => {
    const nodes: Node[] = [];
    while (index < css.length) {
      const start = index;
      while (index < css.length && !'{};'.includes(css[index])) {
        if (css[index] === '"' || css[index] === "'") index = css.indexOf(css[index], index + 1);
        else if (css.startsWith('(', index)) index = css.indexOf(')', index);
        index++;
      }
      const prelude = css.slice(start, index).trim();
      const token = css[index++];
      if (token === undefined) break;
      if (token === '}') return nodes;
      if (token === ';') { if (prelude) nodes.push({kind: 'other', text: prelude}); continue; }
      if (prelude.startsWith('@media') || prelude.startsWith('@supports')) {
        nodes.push({kind: 'block', prelude, children: parseList()});
        continue;
      }
      const bodyStart = index;
      let depth = 1;
      while (index < css.length && depth > 0) {
        if (css[index] === '"' || css[index] === "'") index = css.indexOf(css[index], index + 1);
        else if (css[index] === '{') depth++;
        else if (css[index] === '}') depth--;
        index++;
      }
      const body = css.slice(bodyStart, index - 1);
      nodes.push(prelude.startsWith('@') ? {kind: 'other', text: prelude} : {kind: 'rule', selector: prelude, body});
    }
    return nodes;
  };
  return parseList();
}

function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0, quote = '', start = 0;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quote) { if (character === quote) quote = ''; continue; }
    if (character === '"' || character === "'") quote = character;
    else if (character === '(') depth++;
    else if (character === ')') depth--;
    else if (character === separator && depth === 0) { parts.push(text.slice(start, index)); start = index + 1; }
  }
  parts.push(text.slice(start));
  return parts;
}

type Rgba = [number, number, number, number];
const toLinear = (value: number) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
const fromLinear = (value: number) => value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;

function toOklab([r, g, b]: Rgba): [number, number, number] {
  const [lr, lg, lb] = [r, g, b].map(value => toLinear(value / 255));
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function fromOklab([L, a, b]: [number, number, number]): [number, number, number] | undefined {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map(fromLinear);
  if (rgb.some(value => value < -0.001 || value > 1.001)) return undefined;
  return rgb.map(value => Math.round(Math.min(1, Math.max(0, value)) * 255)) as [number, number, number];
}

export type Role = 'text' | 'surface' | 'border';

/** Lightness targets (OKLab L) for a color's role: text ends up light, surfaces
 * dark, borders subtle. Already-suitable colors (light text, dark accent
 * surfaces such as the brown header) keep roughly their lightness. */
function targetLightness(L: number, role: Role): number {
  if (role === 'text') return L >= 0.75 ? L : 0.93 - L * 0.24;
  if (role === 'surface') return L > 0.55 ? 0.21 + (1 - L) * 0.55 : Math.min(L, 0.42);
  return 0.24 + (1 - L) * 0.45;
}

export function darkColor(color: Rgba, role: Role): Rgba {
  const [L, a, b] = toOklab(color);
  const target = targetLightness(L, role);
  // Pale tints become deep surfaces: soften their chroma so they stay muted.
  for (let chroma = target < L ? 0.7 : 0.95; chroma > 0; chroma -= 0.05) {
    const rgb = fromOklab([target, a * chroma, b * chroma]);
    if (rgb) return [...rgb, color[3]];
  }
  return [...fromOklab([target, 0, 0])!, color[3]];
}

/** Custom properties have no role of their own; pale values are treated as surfaces. */
function roleFor(property: string, color: Rgba): Role {
  if (/^--.*(line|border)/.test(property)) return 'border';
  if (property.startsWith('--')) return toOklab(color)[0] > 0.8 ? 'surface' : 'text';
  if (/^(background|border-image)/.test(property)) return 'surface';
  if (/^border|^column-rule/.test(property)) return 'border';
  return 'text';
}

function parseColor(text: string): Rgba | undefined {
  const lower = text.toLowerCase();
  if (lower === 'white') return [255, 255, 255, 1];
  if (lower === 'black') return [0, 0, 0, 1];
  const hex = /^#([0-9a-f]{3,8})$/.exec(lower)?.[1];
  if (hex && [3, 4, 6, 8].includes(hex.length)) {
    const full = hex.length <= 4 ? [...hex].map(digit => digit + digit).join('') : hex;
    const channels = full.match(/../g)!.map(pair => parseInt(pair, 16));
    return [channels[0], channels[1], channels[2], channels.length === 4 ? channels[3] / 255 : 1];
  }
  const functional = /^rgba?\(([^)]*)\)$/.exec(lower)?.[1];
  if (functional) {
    const parts = functional.split(/[\s,/]+/).filter(Boolean).map(Number);
    if (parts.length >= 3 && parts.every(Number.isFinite)) return [parts[0], parts[1], parts[2], parts[3] ?? 1];
  }
  return undefined;
}

function formatColor([r, g, b, alpha]: Rgba): string {
  const hex = '#' + [r, g, b].map(value => value.toString(16).padStart(2, '0')).join('');
  if (alpha >= 1) return hex;
  return hex + Math.round(alpha * 255).toString(16).padStart(2, '0');
}

const COLOR = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|\b(?:white|black)\b/g;

/** Rewrites color literals outside url(...) and returns undefined when none changed. */
function darkValue(property: string, value: string): string | undefined {
  if (/shadow$/.test(property)) return undefined;
  let changed = false;
  const result = value.split(/(url\([^)]*\))/).map(part => part.startsWith('url(') ? part : part.replace(COLOR, match => {
    const color = parseColor(match);
    if (!color) return match;
    changed = true;
    return formatColor(darkColor(color, roleFor(property, color)));
  })).join('');
  return changed ? result : undefined;
}

const SHORTHAND_COLOR: Record<string, string> = {
  outline: 'outline-color',
  'text-decoration': 'text-decoration-color',
  'column-rule': 'column-rule-color',
};
const COLOR_LONGHAND = /^(color|background-color|background-image|border(-(top|right|bottom|left|block|inline)(-(start|end))?)?-color|outline-color|text-decoration-color|caret-color|accent-color|fill|stroke|column-rule-color)$/;
const isColorToken = (token: string) =>
  !!parseColor(token) || /^(var\(|transparent$|currentcolor$|inherit$|initial$|unset$)/i.test(token);
const isImageToken = (token: string) => /^(url\(|(repeating-)?(linear|radial|conic)-gradient\()/i.test(token);

/** Shorthands are reduced to their color longhands so the mirror never resets
 * widths, styles, positions or sizes set by later light rules. */
function colorLonghands(property: string, value: string): Array<[string, string]> {
  if (property === 'background') {
    const layers = splitTopLevel(value, ',').map(layer => splitTopLevel(layer.trim(), ' ').filter(Boolean));
    const images = layers.map(tokens => tokens.find(isImageToken) ?? 'none');
    const color = layers.at(-1)!.find(isColorToken) ?? 'transparent';
    return [['background-color', color], ['background-image', images.join(', ')]];
  }
  const border = /^border(-(top|right|bottom|left|block|inline)(-(start|end))?)?$/.exec(property);
  if (border || SHORTHAND_COLOR[property]) {
    const target = border ? `${property}-color` : SHORTHAND_COLOR[property];
    return [[target, splitTopLevel(value, ' ').find(isColorToken) ?? 'currentcolor']];
  }
  if (COLOR_LONGHAND.test(property) || (property.startsWith('--') && parseColor(value.trim()))) return [[property, value]];
  return [];
}

function darkDeclarations(body: string): string[] {
  const declarations: string[] = [];
  for (const declaration of splitTopLevel(body, ';')) {
    const colon = declaration.indexOf(':');
    if (colon < 0) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    let value = declaration.slice(colon + 1).trim();
    // The member-chosen backdrop is repeated unchanged so it still wins.
    if (value.includes('var(--site-background')) { declarations.push(`${property}: ${value}`); continue; }
    const important = /\s*!important$/i.test(value) ? ' !important' : '';
    value = value.replace(/\s*!important$/i, '');
    // Colorless values (`transparent`, `none`) still override earlier rules,
    // so they are repeated to keep the light cascade intact.
    for (const [longhand, part] of colorLonghands(property, value))
      declarations.push(`${longhand}: ${darkValue(longhand, part) ?? part}${important}`);
  }
  return declarations;
}

function scopeSelector(selector: string): string {
  const trimmed = selector.trim();
  const root = /^(:root|html)(?![\w-])/.exec(trimmed);
  if (root) return root[1] + SCOPE + trimmed.slice(root[1].length);
  return `${SCOPE} ${trimmed}`;
}

function render(nodes: Node[], indent: string): string[] {
  const output: string[] = [];
  for (const node of nodes) {
    if (node.kind === 'rule') {
      const declarations = darkDeclarations(node.body);
      if (!declarations.length) continue;
      const selectors = splitTopLevel(node.selector, ',').map(scopeSelector);
      output.push(`${indent}${selectors.join(`,\n${indent}`)} {`);
      for (const declaration of declarations) output.push(`${indent}  ${declaration};`);
      output.push(`${indent}}`);
    } else if (node.kind === 'block') {
      const inner = render(node.children, indent + '  ');
      if (inner.length) output.push(`${indent}${node.prelude} {`, ...inner, `${indent}}`);
    }
  }
  return output;
}

export function buildDarkCss(directory: string): string {
  const sections = SOURCES.map(name => {
    const nodes = parse(stripComments(readFileSync(resolve(directory, name), 'utf8')));
    return `/* From ${name}. */\n${render(nodes, '').join('\n')}`;
  });
  return `/* Generated by apps/web/scripts/dark-css.ts from ${SOURCES.join(' and ')}. */\n${sections.join('\n')}\n${OVERRIDES}`;
}
