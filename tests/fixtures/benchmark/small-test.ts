// Small test file for quick benchmark runs
export interface User {
  id: number;
  name: string;
  email: string;
}

export function getUserName(user: User): string {
  return user.name;
}

export function getUserEmail(user: User): string {
  return user.email;
}

export class UserService {
  private users: User[] = [];

  addUser(user: User): void {
    this.users.push(user);
  }

  getUser(id: number): User | undefined {
    return this.users.find(u => u.id === id);
  }

  getAllUsers(): User[] {
    return this.users;
  }
}
