'use strict';
/**
 * scripts/lib/migration-lint.js — Análisis estático de una migración para confirmar que es
 * puramente ADITIVA (solo CREATE TABLE / CREATE INDEX) y que NO referencia tablas históricas.
 * No ejecuta nada.
 */

function stripSqlComments(sql) {
  return String(sql).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

/**
 * @param {string} sql  contenido de la migración
 * @param {string[]} historicalTables  tablas que NO deben aparecer
 * @returns {{ok:boolean, findings:string[], statements:number}}
 */
function lintAdditive(sql, historicalTables = []) {
  const clean = stripSqlComments(sql);
  const findings = [];

  const forbidden = [
    [/\bALTER\b/i, 'ALTER'],
    [/\bUPDATE\s+\w/i, 'UPDATE'],
    [/\bDELETE\s+FROM\b/i, 'DELETE'],
    [/\bDROP\b/i, 'DROP'],
    [/\bTRUNCATE\b/i, 'TRUNCATE'],
    [/\bINSERT\s+INTO\b/i, 'INSERT (backfill)'],
  ];
  for (const [re, name] of forbidden) if (re.test(clean)) findings.push(`contiene ${name}`);

  // Cada sentencia debe ser CREATE TABLE o CREATE [UNIQUE] INDEX.
  const stmts = clean.split(';').map(s => s.trim()).filter(Boolean);
  for (const s of stmts) {
    if (!/^CREATE\s+(TABLE|(UNIQUE\s+)?INDEX)\b/i.test(s)) findings.push(`sentencia no aditiva: ${s.slice(0, 48)}…`);
  }

  // No debe referenciar ninguna tabla histórica.
  for (const t of historicalTables) {
    if (new RegExp(`\\b${t}\\b`, 'i').test(clean)) findings.push(`referencia tabla histórica: ${t}`);
  }

  return { ok: findings.length === 0, findings, statements: stmts.length };
}

module.exports = { lintAdditive, stripSqlComments };
