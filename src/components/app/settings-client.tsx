// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Settings as SettingsIcon, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import type { TransferCandidate } from '@/features/app/reads/members';
import { deleteOrganisation, transferOwnership } from '@/features/app/org-actions';

/**
 * Account settings — data residency and the danger-zone actions (transfer
 * ownership, delete). Real and gated to Admin (`canManage`).
 */
export function SettingsClient({
  orgName,
  canManage = false,
  transferCandidates = [],
}: {
  orgName: string;
  canManage?: boolean;
  /** Other members the org can be handed over to (empty when the caller is alone). */
  transferCandidates?: TransferCandidate[];
}) {
  const router = useRouter();

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [transferConfirm, setTransferConfirm] = useState('');
  const [transferTo, setTransferTo] = useState('');
  const confirmId = useId();
  const transferConfirmId = useId();

  const selectedCandidate = transferCandidates.find((c) => c.userId === transferTo);

  async function handleDelete() {
    setPending(true);
    const res = await deleteOrganisation(confirmText);
    setPending(false);
    if (!res.ok) {
      toast.error(res.error ?? 'Could not delete the organisation.');
      return;
    }
    setDeleteOpen(false);
    if (res.warning) toast.warning(res.warning);
    else toast.success('Organisation deleted.');
    router.push('/');
    router.refresh();
  }

  function openTransfer() {
    setTransferTo('');
    setTransferConfirm('');
    setTransferOpen(true);
  }

  async function handleTransfer() {
    setPending(true);
    const res = await transferOwnership({ userId: transferTo, confirmation: transferConfirm });
    setPending(false);
    if (!res.ok) {
      toast.error(res.error ?? 'Could not transfer the organisation.');
      return;
    }
    setTransferOpen(false);
    toast.success(`${selectedCandidate?.name ?? 'Another Admin'} now runs ${orgName}.`);
    // The initiator has left the org — leave its settings.
    router.push('/');
    router.refresh();
  }

  return (
    <div className='w-full px-4 pt-6 pb-16 sm:px-8 sm:pt-8'>
      <div className='mb-1 flex items-center gap-2.5'>
        <SettingsIcon className='size-6 text-muted-foreground' strokeWidth={1.7} aria-hidden />
        <h1 className='text-2xl font-extrabold tracking-[-0.025em]'>Settings</h1>
      </div>
      <p className='text-muted-foreground mt-1 mb-7 text-sm'>
        <span className='font-mono'>{orgName}</span> organisation
      </p>

      {/* Residency */}
      <section className='mb-8'>
        <h2 className='text-base font-bold'>Data residency</h2>
        <p className='text-muted-foreground mt-1 mb-3.5 text-xs leading-relaxed'>
          Where data at rest and any managed inference live. UK (London) for data at rest, European (UK &amp; EU)
          managed inference (AWS Bedrock).
        </p>
        <div className='border-border bg-card flex items-center justify-between rounded-xl border px-5 py-4'>
          <div className='flex items-center gap-3'>
            <span className='bg-success-bg flex size-10 items-center justify-center rounded-lg'>
              <ShieldCheck className='text-success size-5' strokeWidth={1.5} aria-hidden />
            </span>
            <div>
              <div className='text-sm font-semibold'>UK (London) · eu-west-2</div>
              <div className='text-muted-foreground text-xs'>
                Postgres, Storage and managed-model proxy all resident in-region · covered by the DPA
              </div>
            </div>
          </div>
          <span className='border-success-border bg-success-bg text-success rounded-md border px-2.5 py-1 text-xs font-semibold'>
            Locked
          </span>
        </div>
      </section>

      {/* Danger zone */}
      {canManage && (
        <section>
          <h2 className='text-danger mb-3.5 text-base font-bold'>Danger zone</h2>
          <div className='border-danger-border bg-card overflow-hidden rounded-xl border'>
            <div className='border-danger-border flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3.5'>
              <div>
                <div className='text-sm font-semibold'>Transfer ownership</div>
                <div className='text-muted-foreground mt-0.5 text-xs'>
                  Hand this organisation to another Admin and leave it.
                </div>
                {transferCandidates.length === 0 && (
                  <div className='text-muted-foreground mt-1 text-2xs'>
                    No other Admins yet. The organisation can only be handed to another Admin.
                  </div>
                )}
              </div>
              <Button
                variant='outline'
                size='sm'
                className='border-danger-border text-danger hover:bg-danger-bg'
                onClick={openTransfer}
                disabled={transferCandidates.length === 0}
                title={
                  transferCandidates.length === 0
                    ? 'There is no other Admin to hand the organisation to.'
                    : undefined
                }
              >
                Transfer
              </Button>
            </div>
            <div className='flex flex-wrap items-center justify-between gap-3 px-4 py-3.5'>
              <div>
                <div className='text-sm font-semibold'>Delete organisation &amp; evidence</div>
                <div className='text-muted-foreground mt-0.5 text-xs'>
                  Permanently removes stored history and evidence bundles. Irreversible.
                </div>
              </div>
              <Button
                variant='destructive'
                size='sm'
                onClick={() => {
                  setConfirmText('');
                  setDeleteOpen(true);
                }}
              >
                Delete
              </Button>
            </div>
          </div>
        </section>
      )}

      <Dialog open={deleteOpen} onOpenChange={(o) => !pending && setDeleteOpen(o)}>
        <DialogContent className='max-w-[460px]'>
          <DialogHeader>
            <DialogTitle>Delete organisation &amp; evidence</DialogTitle>
            <DialogDescription>
              This permanently deletes <span className='text-foreground font-semibold'>{orgName}</span> and all of its
              workspaces, snapshots and evidence bundles. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className='flex flex-col gap-1.5'>
            <Label htmlFor={confirmId}>
              Type <span className='text-danger font-mono'>{orgName}</span> to confirm
            </Label>
            <Input
              id={confirmId}
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              autoComplete='off'
              placeholder={orgName}
              aria-label='Organisation name confirmation'
            />
          </div>
          <DialogFooter>
            <Button variant='outline' onClick={() => setDeleteOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button
              variant='destructive'
              onClick={handleDelete}
              loading={pending}
              disabled={confirmText.trim().toLowerCase() !== orgName.trim().toLowerCase()}
            >
              Delete organisation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={transferOpen} onOpenChange={(o) => !pending && setTransferOpen(o)}>
        <DialogContent className='max-w-[460px]'>
          <DialogHeader>
            <DialogTitle>Transfer ownership</DialogTitle>
            <DialogDescription>
              Hand <span className='text-foreground font-semibold'>{orgName}</span> to another Admin. You leave the
              organisation; an Admin can invite you back later.
            </DialogDescription>
          </DialogHeader>
          <div className='flex flex-col gap-1.5'>
            <Label htmlFor='transfer-to'>Hand to</Label>
            <Select
              id='transfer-to'
              ariaLabel='Hand to'
              placeholder='Select an Admin'
              value={transferTo}
              onValueChange={setTransferTo}
              options={transferCandidates.map((c) => ({
                value: c.userId,
                label: c.name,
                hint: `${c.email} · ${c.role}`,
              }))}
              icon={<ShieldCheck className='size-3.5' />}
            />
          </div>
          <div className='flex flex-col gap-1.5'>
            <Label htmlFor={transferConfirmId}>
              Type <span className='text-danger font-mono'>{orgName}</span> to confirm
            </Label>
            <Input
              id={transferConfirmId}
              value={transferConfirm}
              onChange={(e) => setTransferConfirm(e.target.value)}
              autoComplete='off'
              placeholder={orgName}
              aria-label='Organisation name confirmation'
            />
          </div>
          <DialogFooter>
            <Button variant='outline' onClick={() => setTransferOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button
              variant='dark'
              onClick={handleTransfer}
              loading={pending}
              disabled={!transferTo || transferConfirm.trim().toLowerCase() !== orgName.trim().toLowerCase()}
            >
              Transfer ownership
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
