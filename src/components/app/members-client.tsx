"use client";

import { type FormEvent, useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, MoreHorizontal, Plus, ShieldCheck, Trash2, Users, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { type OrgRole, ROLE_LABEL } from "@/features/account/controllers/permissions";
import {
  changeMemberRole,
  inviteMember,
  removeMember,
  revokeInvite,
} from "@/features/app/member-actions";
import type { MembersView, MemberView, PendingInviteView } from "@/features/app/reads/members";
import { cn } from "@/utils/cn";
import { formatDate } from "@/utils/format-date";

/** What each role may do in Terragram, in the words the role menu and legend use. */
const ROLE_HINT: Record<OrgRole, string> = {
  admin: "Runs the organisation: members, billing and settings.",
  maintainer: "Uses Terragram, with no access to settings, members or billing.",
  auditor: "Read-only member for an external assessor. Needs the Team plan.",
  billing_manager: "Billing only: the plan, prepaid credit and invoices.",
};

const formatLastSignIn = (iso: string | null) => (iso ? formatDate(iso) : "Never");

function RolePill({ role }: { role: OrgRole }) {
  return (
    <span
      className={cn(
        "inline-flex rounded-full border px-2.5 py-0.5 text-2xs font-semibold whitespace-nowrap",
        role === "admin"
          ? "border-surface-border bg-surface text-surface-foreground"
          : "border-line-strong bg-surface-sunken text-ink-soft",
      )}
    >
      {ROLE_LABEL[role]}
    </span>
  );
}

const TH = "px-4 py-2.5 text-2xs font-semibold tracking-[0.05em] text-muted-foreground uppercase font-mono";
const TD = "px-4 py-3 align-middle";

type Confirm =
  | { kind: "remove"; member: MemberView }
  | { kind: "revoke"; invite: PendingInviteView }
  | null;

/**
 * The Members page: the people in the organisation and their roles, the pending
 * invitations, and the invite dialog. Admin only (the page is guarded on
 * `members.manage`, and every action re-checks it).
 *
 * An invite is emailed when the deployment has email configured, and always
 * produces a link the Admin can share, so the dialog says which happened. The
 * invitee joins by opening it, or automatically when they sign in with the
 * invited address.
 */
export function MembersClient({ view }: { view: MembersView }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<OrgRole>("maintainer");
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [inviteEmailed, setInviteEmailed] = useState(false);
  const emailId = useId();
  const roleId = useId();
  const errorId = useId();

  const roleOptions = view.assignableRoles.map((r) => ({
    value: r,
    label: ROLE_LABEL[r],
    hint: ROLE_HINT[r],
  }));

  function openInvite() {
    setEmail("");
    setRole("maintainer");
    setInviteError(null);
    setInviteLink(null);
    setInviteOpen(true);
  }

  function submitInvite(event: FormEvent) {
    event.preventDefault();
    setInviteError(null);
    startTransition(async () => {
      const res = await inviteMember({ email, role });
      if (!res.ok) {
        setInviteError(res.error);
        return;
      }
      setInviteLink(res.inviteUrl);
      setInviteEmailed(res.emailed);
      router.refresh();
    });
  }

  async function copyLink() {
    if (!inviteLink) return;
    try {
      await navigator.clipboard.writeText(inviteLink);
      toast.success("Invite link copied");
    } catch {
      toast.error("Could not copy. Select the link and copy it yourself.");
    }
  }

  function run(id: string, work: () => Promise<{ ok: true } | { ok: false; error: string }>, done: string) {
    setBusyId(id);
    startTransition(async () => {
      const res = await work();
      setBusyId(null);
      setConfirm(null);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(done);
      router.refresh();
    });
  }

  function changeRole(member: MemberView, next: OrgRole) {
    if (next === member.role) return;
    run(
      member.userId,
      () => changeMemberRole({ userId: member.userId, role: next }),
      `${member.name} is now ${/^[AEIOU]/.test(ROLE_LABEL[next]) ? "an" : "a"} ${ROLE_LABEL[next]}.`,
    );
  }

  function runConfirmed() {
    if (confirm?.kind === "remove") {
      const { member } = confirm;
      run(member.userId, () => removeMember(member.userId), `${member.name} was removed.`);
    } else if (confirm?.kind === "revoke") {
      const { invite } = confirm;
      run(invite.id, () => revokeInvite(invite.id), `The invite for ${invite.email} was revoked.`);
    }
  }

  return (
    <div className="w-full px-4 pt-6 pb-16 sm:px-8 sm:pt-8">
      <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="mb-1 flex items-center gap-2.5">
            <Users className="size-6 text-muted-foreground" strokeWidth={1.7} aria-hidden />
            <h1 className="text-2xl font-extrabold tracking-[-0.025em]">Members</h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            People in <span className="font-mono">{view.orgLabel}</span>. Roles decide who runs the
            organisation and its billing; every member&rsquo;s workspaces stay their own.
          </p>
        </div>
        <Button variant="dark" size="sm" className="h-9" onClick={openInvite}>
          <Plus className="size-3.5" strokeWidth={1.8} aria-hidden /> Invite member
        </Button>
      </div>

      <section aria-labelledby="members-heading" className="mb-8">
        <h2 id="members-heading" className="sr-only">
          Members
        </h2>
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full min-w-[620px] text-left text-sm">
            <caption className="sr-only">Members of {view.orgLabel}</caption>
            <thead className="border-b border-line-strong bg-surface-subtle">
              <tr>
                <th scope="col" className={TH}>
                  Member
                </th>
                <th scope="col" className={TH}>
                  Role
                </th>
                <th scope="col" className={TH}>
                  Last signed in
                </th>
                <th scope="col" className={TH}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {view.members.map((m) => (
                <tr key={m.userId}>
                  <td className={TD}>
                    <div className="flex items-center gap-2 text-sm font-semibold">
                      {m.name}
                      {m.isSelf && (
                        <span className="rounded-full bg-surface-sunken px-1.5 py-0.5 text-2xs font-semibold text-muted-foreground">
                          You
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground">{m.email}</div>
                    {m.joinedHow && <div className="text-2xs text-muted-foreground">{m.joinedHow}</div>}
                  </td>
                  <td className={TD}>
                    <RolePill role={m.role} />
                  </td>
                  <td className={cn(TD, "text-xs text-muted-foreground")}>{formatLastSignIn(m.lastSignInAt)}</td>
                  <td className={cn(TD, "text-right")}>
                    {m.isSelf ? null : (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Manage ${m.name}`}
                            loading={pending && busyId === m.userId}
                          >
                            {!(pending && busyId === m.userId) && <MoreHorizontal aria-hidden />}
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-[260px]">
                          <DropdownMenuLabel className="font-mono text-2xs font-semibold tracking-[0.05em] text-muted-foreground uppercase">
                            Change role
                          </DropdownMenuLabel>
                          {roleOptions.map((o) => (
                            <DropdownMenuItem
                              key={o.value}
                              onSelect={() => changeRole(m, o.value)}
                              className="flex items-start justify-between gap-3"
                            >
                              <span className="flex min-w-0 flex-col">
                                <span className="text-xs font-semibold">{o.label}</span>
                                <span className="text-2xs font-normal text-muted-foreground">{o.hint}</span>
                              </span>
                              {o.value === m.role && (
                                <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-label="Current role" />
                              )}
                            </DropdownMenuItem>
                          ))}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            variant="destructive"
                            onSelect={() => setConfirm({ kind: "remove", member: m })}
                          >
                            <Trash2 strokeWidth={1.7} aria-hidden /> Remove from organisation
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {view.invites.length > 0 && (
        <section aria-labelledby="invites-heading" className="mb-8">
          <h2 id="invites-heading" className="mb-3 text-base font-bold">
            Pending invitations
          </h2>
          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full min-w-[620px] text-left text-sm">
              <caption className="sr-only">Pending invitations</caption>
              <thead className="border-b border-line-strong bg-surface-subtle">
                <tr>
                  <th scope="col" className={TH}>
                    Invitee
                  </th>
                  <th scope="col" className={TH}>
                    Role
                  </th>
                  <th scope="col" className={TH}>
                    Expiry
                  </th>
                  <th scope="col" className={TH}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {view.invites.map((inv) => (
                  <tr key={inv.id}>
                    <td className={TD}>
                      <div className="text-sm font-semibold">{inv.email}</div>
                      {inv.invitedBy && (
                        <div className="text-2xs text-muted-foreground">Invited by {inv.invitedBy}</div>
                      )}
                    </td>
                    <td className={TD}>
                      <RolePill role={inv.role} />
                    </td>
                    <td className={cn(TD, "text-xs", inv.expired ? "font-semibold text-danger" : "text-muted-foreground")}>
                      {inv.expired ? "Expired" : `Expires ${formatDate(inv.expiresAt)}`}
                    </td>
                    <td className={cn(TD, "text-right")}>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Revoke the invite for ${inv.email}`}
                        loading={pending && busyId === inv.id}
                        onClick={() => setConfirm({ kind: "revoke", invite: inv })}
                      >
                        {!(pending && busyId === inv.id) && <X aria-hidden />}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section aria-labelledby="roles-heading">
        <h2 id="roles-heading" className="mb-3 font-mono text-2xs font-semibold tracking-[0.05em] text-muted-foreground uppercase">
          Roles
        </h2>
        <ul className="divide-y divide-line rounded-xl border border-border bg-card">
          {(Object.keys(ROLE_HINT) as OrgRole[]).map((r) => (
            <li key={r} className="flex items-start gap-3 px-4 py-3">
              <span className="w-32 shrink-0">
                <RolePill role={r} />
              </span>
              <p className="text-xs leading-relaxed text-muted-foreground">{ROLE_HINT[r]}</p>
            </li>
          ))}
        </ul>
      </section>

      <Dialog open={inviteOpen} onOpenChange={(o) => !pending && setInviteOpen(o)}>
        <DialogContent className="max-w-[480px]">
          {inviteLink ? (
            <>
              <DialogHeader>
                <DialogTitle>Invitation created</DialogTitle>
                <DialogDescription>
                  {inviteEmailed ? (
                    <>
                      We emailed this link to{" "}
                      <span className="font-semibold text-foreground">{email}</span>. You can also send it
                      yourself.
                    </>
                  ) : (
                    <>
                      The invitation email was not sent, so send this link to{" "}
                      <span className="font-semibold text-foreground">{email}</span> yourself.
                    </>
                  )}{" "}
                  It works once and expires in 14 days. They also join automatically when they sign in
                  with that address.
                </DialogDescription>
              </DialogHeader>
              <div className="flex items-center gap-2">
                <Input
                  readOnly
                  value={inviteLink}
                  aria-label="Invite link"
                  className="font-mono text-xs"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Button variant="outline" onClick={copyLink}>
                  <Copy aria-hidden /> Copy
                </Button>
              </div>
              <DialogFooter>
                <Button variant="dark" onClick={() => setInviteOpen(false)}>
                  Done
                </Button>
              </DialogFooter>
            </>
          ) : (
            <form onSubmit={submitInvite} className="flex flex-col gap-4">
              <DialogHeader>
                <DialogTitle>Invite a member</DialogTitle>
                <DialogDescription>
                  They join <span className="font-mono">{view.orgLabel}</span> with the role you pick.
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={emailId}>Email address</Label>
                <Input
                  id={emailId}
                  type="email"
                  inputMode="email"
                  autoComplete="off"
                  placeholder="teammate@company.com"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setInviteError(null);
                  }}
                  aria-invalid={inviteError ? true : undefined}
                  aria-describedby={inviteError ? errorId : undefined}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={roleId}>Role</Label>
                <Select
                  id={roleId}
                  ariaLabel="Role"
                  value={role}
                  onValueChange={(v) => setRole(v as OrgRole)}
                  options={roleOptions}
                  icon={<ShieldCheck className="size-3.5" />}
                />
                {!view.assignableRoles.includes("auditor") && (
                  <p className="text-2xs text-muted-foreground">
                    The read-only Auditor role is part of the Team plan.
                  </p>
                )}
              </div>
              {inviteError && (
                <p id={errorId} role="alert" className="text-xs font-medium text-danger">
                  {inviteError}
                </p>
              )}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setInviteOpen(false)} disabled={pending}>
                  Cancel
                </Button>
                <Button type="submit" loading={pending} disabled={!email.trim()}>
                  Create invite
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm?.kind === "revoke" ? "Revoke this invite?" : "Remove this member?"}
        description={
          confirm?.kind === "revoke" ? (
            <>
              The link sent to <span className="font-semibold text-foreground">{confirm.invite.email}</span>{" "}
              stops working. You can invite them again later.
            </>
          ) : (
            <>
              <span className="font-semibold text-foreground">{confirm?.member.name}</span> loses access to{" "}
              {view.orgLabel} straight away. Their own workspaces are not affected, and you can invite
              them again later.
            </>
          )
        }
        confirmLabel={confirm?.kind === "revoke" ? "Revoke invite" : "Remove member"}
        destructive
        pending={pending}
        onConfirm={runConfirmed}
      />
    </div>
  );
}
