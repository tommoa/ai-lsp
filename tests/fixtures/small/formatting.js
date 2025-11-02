// Small file: formatting and style improvements
function process(data) {
  const filtered = data.filter(x => x > 0);
  return filtered.map(x => x * 2);
}

const arr = [1, -2, 3, -4, 5];
const result = process(arr);
