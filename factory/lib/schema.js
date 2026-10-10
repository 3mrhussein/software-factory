'use strict';
// Tiny JSON Schema (draft-07 subset) validator. The schema files in
// factory/schema/ are the single source of truth for job.json and config.json.

const path = require('path');
const { paths, readJSON, die } = require('./util');

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);

function typeMatches(value, type) {
  const t = typeOf(value);
  return type === t || (type === 'number' && t === 'integer');
}

function validate(value, schema, root = schema, at = '$', errors = []) {
  if (schema.$ref) {
    const target = schema.$ref.replace(/^#\//, '').split('/').reduce((o, k) => o[k], root);
    return validate(value, target, root, at, errors);
  }
  if (schema.type) {
    const types = [].concat(schema.type);
    if (!types.some((t) => typeMatches(value, t))) {
      errors.push(`${at}: expected ${types.join('|')}, got ${typeOf(value)}`);
      return errors;
    }
  }
  if ('const' in schema && value !== schema.const) errors.push(`${at}: must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`);
  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) errors.push(`${at}: too short`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${at}: must match /${schema.pattern}/`);
  }
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) errors.push(`${at}: must be >= ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) errors.push(`${at}: must be <= ${schema.maximum}`);
  }
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => validate(v, schema.items, root, `${at}[${i}]`, errors));
  if (typeOf(value) === 'object') {
    for (const key of schema.required || []) if (!(key in value)) errors.push(`${at}: missing "${key}"`);
    const props = schema.properties || {};
    for (const [key, v] of Object.entries(value)) {
      if (props[key]) validate(v, props[key], root, `${at}.${key}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${at}: unknown property "${key}"`);
      else if (typeof schema.additionalProperties === 'object') validate(v, schema.additionalProperties, root, `${at}.${key}`, errors);
    }
  }
  return errors;
}

const cache = {};
function load(name) {
  return (cache[name] ||= readJSON(path.join(paths().schema, `${name}.schema.json`)));
}

function check(name, value, label = name) {
  const errors = validate(value, load(name));
  if (errors.length) die(`${label} failed schema validation:\n  ${errors.join('\n  ')}`);
  return value;
}

module.exports = { validate, check, load };
