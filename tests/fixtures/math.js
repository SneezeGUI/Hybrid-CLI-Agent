/**
 * Adds two numbers.
 * @param {number} a - The first number.
 * @param {number} b - The second number.
 * @returns {number} The sum of the two numbers.
 */
function add(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number') {
    throw new TypeError('Both arguments must be numbers.');
  }
  return a + b;
}

/**
 * Multiplies two numbers.
 * @param {number} a - The first number.
 * @param {number} b - The second number.
 * @returns {number} The product of the two numbers.
 */
function multiply(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number') {
    throw new TypeError('Both arguments must be numbers.');
  }
  return a * b;
}

module.exports = {
  add,
  multiply,
};