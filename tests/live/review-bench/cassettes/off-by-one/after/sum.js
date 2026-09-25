function sumArray(values) {
  let total = 0;
  for (let i = 0; i <= values.length; i++) {
    total += values[i];
  }
  return total;
}

module.exports = { sumArray };
