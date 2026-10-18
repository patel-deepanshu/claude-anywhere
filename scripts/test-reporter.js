'use strict';

/**
 * node --test reporter used by scripts/test.js next to the normal one: it writes one JSON line
 * per failing test (file, line, name, error) so the runner can print a recap of the failures
 * after the run, where a CI log that keeps only its last lines still shows them. A parent whose
 * only failure is its failing subtests is left out (the subtests are listed), as are todo tests.
 */

const util = require('util');

/** The error text of a failure: the cause's stack (which starts with its message) or its message. */
function errorText(err) {
  if (err == null) return '';
  const cause = err.cause !== undefined && err.cause !== null ? err.cause : err;
  if (typeof cause === 'string') return cause;
  if (typeof cause !== 'object') return util.inspect(cause);
  const message = typeof cause.message === 'string' ? cause.message : '';
  const stack = typeof cause.stack === 'string' ? cause.stack : '';
  const head = message.split('\n')[0];
  if (stack && (!head || stack.includes(head))) return stack;
  if (message) return [`${cause.name || 'Error'}: ${message}`, stack].filter(Boolean).join('\n');
  return util.inspect(cause, { depth: 2 });
}

module.exports = async function* failuresReporter(source) {
  for await (const event of source) {
    if (!event || event.type !== 'test:fail') continue;
    const data = event.data || {};
    const err = data.details && data.details.error;
    if (data.todo || (err && err.failureType === 'subtestsFailed')) continue;
    const record = {
      file: data.file || null,
      line: data.line || null,
      name: String(data.name),
      failureType: (err && err.failureType) || null,
      error: errorText(err),
    };
    yield `${JSON.stringify(record)}\n`;
  }
};

module.exports.errorText = errorText;
