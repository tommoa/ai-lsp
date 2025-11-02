// Medium file: multiple related edits across the file
interface User {
  name: string;
  email: string;
  age: number;
}

function validateUser(user: User): boolean {
  if (!user.name || user.name.length === 0) {
    return false;
  }
  if (!user.email || user.email.length === 0) {
    return false;
  }
  if (user.age < 0 || user.age > 150) {
    return false;
  }
  return true;
}

function formatUser(user: User): string {
  return user.name + ' <' + user.email + '>';
}

function processUsers(users: User[]): string[] {
  const valid = users.filter(u => validateUser(u));
  return valid.map(u => formatUser(u));
}

// Example usage
const users: User[] = [
  { name: 'Alice', email: 'alice@example.com', age: 30 },
  { name: '', email: 'bob@example.com', age: 25 },
  { name: 'Charlie', email: 'charlie@example.com', age: 200 },
];

const result = processUsers(users);
console.log(result);
