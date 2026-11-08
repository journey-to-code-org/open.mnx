// Invoices: shadcn/ui (Radix underneath) for the app's chrome, dialogs and menus; Zubra
// components for the table, the chart, the badges and the form's status picker. One theme drives
// both: shadcn's CSS variables, switched by the theme menu.
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import InvoiceTable from './zubra/invoice-table.zb';
import RevenueChart from './zubra/revenue-chart.zb';
import StatusBadge from './zubra/status-badge.zb';
import StatusPicker from './zubra/status-picker.zb';
import { months, seed } from './invoices.js';

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const FILTERS = ['all', 'draft', 'sent', 'paid', 'overdue'];

export default function App() {
  const [invoices, setInvoices] = useState(seed);
  const [filter, setFilter] = useState('all');
  const [mode, setMode] = useState('light');
  const [accent, setAccent] = useState('zinc');
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState(null);

  // The theme is classes on <html>, as shadcn does it: they swap the CSS variables everything reads.
  useEffect(() => {
    document.documentElement.classList.toggle('dark', mode === 'dark');
    document.documentElement.classList.toggle('theme-blue', accent === 'blue');
  }, [mode, accent]);

  const totals = useMemo(() => ({
    outstanding: invoices.filter((invoice) => invoice.status === 'sent' || invoice.status === 'overdue').reduce((sum, invoice) => sum + invoice.amount, 0),
    paid: invoices.filter((invoice) => invoice.status === 'paid').reduce((sum, invoice) => sum + invoice.amount, 0),
    overdue: invoices.filter((invoice) => invoice.status === 'overdue').length,
  }), [invoices]);
  const open = invoices.find((invoice) => invoice.id === openId);

  function create(event) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const number = Math.max(...invoices.map((invoice) => Number(invoice.id.slice(4)))) + 1;
    setInvoices([{ id: `INV-${number}`, client: data.get('client'), amount: Number(data.get('amount')), due: data.get('due'), status: data.get('status') }, ...invoices]);
    setCreating(false);
  }
  const markPaid = (id) => setInvoices(invoices.map((invoice) => (invoice.id === id ? { ...invoice, status: 'paid' } : invoice)));

  return (
    <div className="min-h-screen">
      <header className="border-b">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-3">
          <p className="font-semibold tracking-tight">Ledgerly <span className="text-muted-foreground">· shadcn/ui and Zubra</span></p>
          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">Theme</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuLabel>Mode</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={mode} onValueChange={setMode}>
                  <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Accent</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={accent} onValueChange={setAccent}>
                  <DropdownMenuRadioItem value="zinc">Zinc</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="blue">Blue</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <Dialog open={creating} onOpenChange={setCreating}>
              <DialogTrigger asChild>
                <Button size="sm">New invoice</Button>
              </DialogTrigger>
              <DialogContent>
                <form onSubmit={create} className="grid gap-4">
                  <DialogHeader>
                    <DialogTitle>New invoice</DialogTitle>
                    <DialogDescription>The status picker is a Zubra form control: the form submits it like an input.</DialogDescription>
                  </DialogHeader>
                  <div className="grid gap-2">
                    <Label htmlFor="client">Client</Label>
                    <Input id="client" name="client" required placeholder="Acme Corp" />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="grid gap-2">
                      <Label htmlFor="amount">Amount</Label>
                      <Input id="amount" name="amount" type="number" min="1" step="0.01" required />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="due">Due</Label>
                      <Input id="due" name="due" type="date" required defaultValue="2026-12-15" />
                    </div>
                  </div>
                  <div className="grid gap-2">
                    <span className="text-sm font-medium">Status</span>
                    <StatusPicker name="status" label="Status" />
                  </div>
                  <DialogFooter>
                    <DialogClose asChild><Button type="button" variant="outline">Cancel</Button></DialogClose>
                    <Button type="submit">Create invoice</Button>
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-6 px-6 py-6">
        <div className="grid gap-4 sm:grid-cols-3">
          <Card className="gap-2"><CardHeader><CardDescription>Outstanding</CardDescription><CardTitle className="text-2xl tabular-nums" data-stat="outstanding">{money.format(totals.outstanding)}</CardTitle></CardHeader></Card>
          <Card className="gap-2"><CardHeader><CardDescription>Paid</CardDescription><CardTitle className="text-2xl tabular-nums" data-stat="paid">{money.format(totals.paid)}</CardTitle></CardHeader></Card>
          <Card className="gap-2"><CardHeader><CardDescription>Overdue</CardDescription><CardTitle className="text-2xl tabular-nums" data-stat="overdue">{totals.overdue}</CardTitle></CardHeader></Card>
        </div>

        <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
          <Card>
            <CardHeader className="flex flex-wrap items-center justify-between gap-2">
              <div className="grid gap-1.5"><CardTitle>Invoices</CardTitle><CardDescription>A Zubra table: choose a row to open it.</CardDescription></div>
              <div role="group" aria-label="Show" className="flex flex-wrap gap-1">
                {FILTERS.map((name) => (
                  <Button key={name} size="sm" variant={filter === name ? 'secondary' : 'ghost'} aria-pressed={filter === name} className="capitalize" onClick={() => setFilter(name)}>{name}</Button>
                ))}
              </div>
            </CardHeader>
            <CardContent>
              <InvoiceTable invoices={invoices} filter={filter} onInvoiceOpen={(event) => setOpenId(event.detail)} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Revenue</CardTitle><CardDescription>A shadow-DOM Zubra chart on shadcn's chart colours.</CardDescription></CardHeader>
            <CardContent><RevenueChart months={months} /></CardContent>
          </Card>
        </div>
      </main>

      <Dialog open={!!open} onOpenChange={(value) => !value && setOpenId(null)}>
        {open && (
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{open.id}</DialogTitle>
              <DialogDescription>{open.client}</DialogDescription>
            </DialogHeader>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <dt className="text-muted-foreground">Amount</dt><dd className="text-right tabular-nums">{money.format(open.amount)}</dd>
              <dt className="text-muted-foreground">Due</dt><dd className="text-right">{open.due}</dd>
              <dt className="text-muted-foreground">Status</dt><dd className="text-right"><StatusBadge status={open.status} /></dd>
            </dl>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpenId(null)}>Close</Button>
              <Button disabled={open.status === 'paid'} onClick={() => markPaid(open.id)}>Mark as paid</Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
