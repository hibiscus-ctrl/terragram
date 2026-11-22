// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Throwaway signed-in users for the seeded suites.
 *
 * Every persona is a fresh, confirmed `apitest-terragram-*@example.invalid` user
 * signed in through the real /auth/confirm path. `teardown()` deletes each one
 * and everything their sign-in provisioned (see `deleteUser` in seed.ts), so a
 * suite that seeds must call it from `after()`.
 */
import { type Admin, deleteUser, seedEmail } from "./seed.ts";
import { createAuthUser, signIn } from "./session.ts";

export type Persona = { email: string; userId: string; cookie: string };

export class Fixture {
  readonly admin: Admin;
  readonly #users: { id: string; email: string }[] = [];

  constructor(admin: Admin) {
    this.admin = admin;
  }

  /** A new user, signed in. `who` names its role in the suite (`owner`, `other`…). */
  async persona(who: string): Promise<Persona> {
    const email = seedEmail(who);
    const userId = await createAuthUser(this.admin, email);
    this.#users.push({ id: userId, email });
    return { email, userId, cookie: (await signIn(this.admin, email)).cookie };
  }

  async teardown(): Promise<void> {
    for (const u of this.#users) await deleteUser(this.admin, u.id, u.email);
  }
}
