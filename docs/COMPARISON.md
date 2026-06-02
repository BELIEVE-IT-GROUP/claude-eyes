# Comparison: claude-eyes vs. the field

## TL;DR

| | claude-eyes | Lovable | Cursor | Continue.dev | v0 by Vercel |
|---|---|---|---|---|---|
| **Live UI feedback to AI** | ✅ | ✅ | ❌ | ❌ | ✅ |
| **Use your own IDE** | ✅ Claude Code | ❌ web only | ✅ fork of VS Code | ✅ VS Code ext | ❌ web only |
| **Use your own stack** | ✅ any | ❌ React+Tailwind+shadcn | ✅ | ✅ | ❌ React+Tailwind |
| **Self-hosted** | ✅ all local | ❌ SaaS | partial | ✅ | ❌ SaaS |
| **Free of subscription** | ✅ | ❌ | paid plans | ✅ free + paid | ❌ |
| **Visual diff between turns** | ✅ pixelmatch | ❌ | ❌ | ❌ | ❌ |
| **Multi-viewport autocapture** | ✅ mobile/tablet/desktop | partial | ❌ | ❌ | partial |
| **External tab capture (Figma)** | ✅ planned | ❌ | ❌ | ❌ | ❌ |
| **Works on existing project** | ✅ any frontend | ❌ scaffolds new | ✅ | ✅ | ✅ import |
| **License** | GPL-3.0 | proprietary | proprietary | Apache-2.0 | proprietary |

---

## When each tool wins

### Use Lovable when
- You're starting from zero, no code yet.
- You want a polished React app shipped to a Vercel preview URL in 15 minutes.
- You don't care about the underlying stack as long as it works.

### Use Cursor when
- You want autocomplete + chat tightly integrated into a VS Code-like editor.
- You don't need the AI to see rendered UI — you're mostly editing logic.
- You're fine with the proprietary fork model.

### Use Continue.dev when
- You want an open-source AI assistant inside your existing VS Code.
- You're OK with text-only context.
- You want to self-host your model gateway.

### Use v0 when
- You want generative React components delivered as code-paste-able output.
- You work in a Tailwind + shadcn world.
- You don't mind paying for the polish.

### Use claude-eyes when
- You're already in Claude Code (terminal-native workflow).
- You want the AI to **see** your dev server, not just read your code.
- You want **product critique** — the AI calling out spacing, hierarchy, contrast issues mid-edit.
- You want it open-source, self-hosted, and adaptable to any frontend stack.
- You use cmux as your terminal (the WKWebView bridge mode that's coming).

---

## What claude-eyes does that nothing else does

### 1. Regression critique after fixes

After applying changes the model is asked to evaluate, the model can spot **second-order problems** the change introduced. Example from the validation pilot:

> *"The footer is now better designed than the main content. The chips of code have more visual detail than the `<h2>` of the cards. That tells you something about how undercrafted the cards were."*

This requires the model to see **both** the before and the after, which the visual diff provides.

### 2. Honest "depends" rejection

Forcing the model to pick a design direction with screenshot evidence breaks the "ambos son válidos" failure mode. From the pilot:

> *"V1 Linear wins. The orange-red gradient on the hero competes with the red CTA button at the same level — the eye doesn't know where to go first. The blank-typography hero lets the button stay the focal point."*

A non-visual model would have said "depends on the audience."

### 3. Critique with prescription

The model doesn't just identify problems. It prescribes fixes with **technical specifics**:

> *"Use 1px inner highlight at 4% white on the top edge, soft shadow on the bottom. That's how Linear and Stripe get depth on dark gray cards without sacrificing minimalism."*

This is upper-mid senior designer output, not generic critique.

### 4. Unsolicited findings

In the Level 4 stress test, when asked for 3 problems the model found 4. The unsolicited one was:

> *"The footer is monospace with `--muted` color over `--bg` — it's nearly unreadable and breaks the typographic hierarchy. Either monospace is a recurring language in the app, or the footer should be sans."*

Visual context makes the AI a stricter reviewer, not just a more articulate one.

---

## What claude-eyes is **not** trying to be

- **A code generator.** It doesn't generate React from a prompt. Claude Code already does that. claude-eyes makes Claude Code's existing generation feedback-loop visual.
- **An IDE.** Use whichever editor you want inside Claude Code's terminal session.
- **A design system.** Bring your own.
- **A replacement for a designer.** It's a peer for the developer who doesn't have a designer in the room.

---

## Migration paths

### From Lovable to claude-eyes
- Export your Lovable project as a Vite app.
- Drop into `~/Developer/your-project/`.
- Run claude-eyes daemon pointed at the Vite dev server.
- Continue iterating in Claude Code instead of Lovable's chat.

### From Cursor to claude-eyes
- Keep using Cursor for typing-time autocomplete.
- Use Claude Code + claude-eyes when you want product critique on rendered UI.
- They are not mutually exclusive.

### From v0 to claude-eyes
- Use v0 to generate the initial component.
- Move it into your project.
- Use claude-eyes to iterate on real layout, real spacing, real responsive behavior.
