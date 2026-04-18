# Jarviot Invoices

Local invoice generator for Jarviot Technologies → Molecule Ventures.

## Setup (one time)

```bash
cd jarviot-invoices
npm install
```

## Run

```bash
npm run dev
```

Opens at [http://localhost:3000](http://localhost:3000)

## Download PDF

Click **⌘P Download PDF** on any invoice preview. On macOS, use the **PDF → Save as PDF** dropdown in the bottom-left of the print dialog.

## Features

- **Dashboard** — overview cards, pending drafts, recent invoices
- **Create/Edit** — line items with GST calc, optional HSN/SAC, auto invoice numbering
- **Recurring** — set monthly/quarterly/yearly recurrence; drafts auto-generate on app load
- **Folder** — browse invoices by year → month
- **Pixel-perfect PDF** — matches Refrens invoice template with signature

## Data

All invoices are stored in `localStorage` — persistent across browser sessions, no server needed.
