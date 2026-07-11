// ごく普通の TypeScript(API クライアント)
interface User {
  id: number;
  name: string;
  email: string;
  active: boolean;
}

interface Page<T> {
  items: T[];
  total: number;
  offset: number;
}

export class ApiClient {
  constructor(private readonly baseUrl: string) {}

  async fetchUsers(offset = 0, limit = 20): Promise<Page<User>> {
    const res = await fetch(`${this.baseUrl}/users?offset=${offset}&limit=${limit}`);
    if (!res.ok) {
      throw new Error(`fetch failed: ${res.status}`);
    }
    return (await res.json()) as Page<User>;
  }

  async findByName(name: string): Promise<User | null> {
    let offset = 0;
    while (true) {
      const page = await this.fetchUsers(offset, 50);
      const hit = page.items.find((u) => u.name === name);
      if (hit) return hit;
      offset += page.items.length;
      if (offset >= page.total) return null;
    }
  }
}
