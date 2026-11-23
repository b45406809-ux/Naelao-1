# Corporate recovery claims prototype

## Purpose and design partnership

Create a fictional-data demonstration for a conversation with Bulisa Mbano, partner and head of advisory at Grant Thornton Zimbabwe. Ask him to challenge the workflow, identify existing tools, introduce a practitioner who handles the work, and, if he sees value, help find the people who could approve a funded firm pilot. His personal feedback, any firm pilot, and a public endorsement are separate arrangements and require the appropriate agreement. Do not imply that Grant Thornton has endorsed or adopted Naelao.

The proposed first workflow is a claims review and meeting brief for a fictional Zimbabwean distributor. A reviewer can trace each key number to a source document, correct an extracted value, and regenerate a brief that reflects the reviewed register. Confirm the problem and terminology with practitioners before treating this as their actual process.

## Research and competitive context

- Zimbabwe's [Insolvency Act 2018](https://zimlii.org/akn/zw/act/2018/7/eng%402018-06-25) addresses the first creditors' meeting and corporate rescue plans. Section 142 includes creditor information and indications of proved claims. The [OK Zimbabwe Gazette notice](https://zimlii.org/akn/zw/act/si/2026/50/eng%402026-03-13/source.pdf) refers to claim forms and supporting documents. These sources motivate a demo, not automated legal determinations. Have qualified practitioners verify current requirements and procedure.
- [Aryza Connect](https://www.aryza.com/au_EN/products/aryza-connect/) offers creditor submissions and voting, and [Turnkey IPS](https://turnkey-ips.com/) offers case and stakeholder management. Learn what Grant Thornton Zimbabwe already uses and whether an evidence review layer that imports existing exports would help. [Grant Thornton Advisors in the US](https://www.grantthornton.com/insights/press-releases/2026/july/gt-advisors-partners-with-fieldguide-to-power-next-generation-risk) has announced a Fieldguide partnership; this does not establish the Zimbabwe team's tools.
- [Legora and Mannheimer Swartling](https://www.mannheimerswartling.se/en/about-the-firm/innovation/ai-digitaltools/) illustrate developing alongside domain experts. Request substantive workflow feedback and a paid, scoped pilot rather than assuming endorsement or procurement authority.

## Demonstration

Seed a synthetic ledger and a small collection of fictional claim forms, invoices and statements. Use fictional company and creditor names. Include a claim for US$48,000 with a US$42,000 ledger balance, a US$6,000 variance, one possible duplicate invoice reference, a missing document under a demo checklist, one ambiguous field and a second currency. Label the dataset and legal checklist as illustrative.

1. Import one fresh synthetic claim packet and propose extracted name, amount, currency and references with page-level evidence. Mark unreadable fields unknown and permit correction.
2. Display the variance and a possible duplicate with both source references. The reviewer can confirm, correct, dismiss or request more evidence. The machine flags possibilities and does not make legal decisions.
3. Ask the assistant what needs review before a meeting. Retrieve current, authorized microapp records through MCP v2 operations and cite supporting evidence. Make deterministic calculations in the application; group totals by currency and do not assume conversion rates.
4. Change a figure or attach missing evidence. Record actor, old/new value, source and review state, then refresh the exception queue and the draft partner brief.
5. Produce a one-page meeting brief and register export with links from figures to individual records. Show unresolved items and distinguish received, internally reviewed, formally proved and admitted statuses as defined by the practitioner. A human reviews and authorizes any external communication.

Three screens are sufficient: Claims Register, Evidence Review and Meeting Brief. Use bounded CSV import and selectable-text sample PDFs. Show a real fresh import; preseed the other examples. Display failures and source uncertainty. Never fabricate citations, acceptance, dates or legal conclusions.

## Naelao template design

One fictional engagement Space contains a Claims Review project with a claims microapp, evidence viewer, exception queue, assistant and brief generator. Configure partner, reviewer and assistant roles with scoped access. MCP v2 exposes typed reads for claims, evidence and review state, and controlled writes for corrections and draft reviews. Writes use authorization, revision checks and audit history. The assistant cites source pages, treats documents as untrusted, asks when ambiguous, and cannot decide claim validity or send notices autonomously. The generated brief is an artifact linked to its source revisions.

Reuse existing Space, Project, microapp, Knowledge, role, assistant, artifact and tool contracts where they actually work. Reconcile this proposal against the live branch and caller paths before claiming support. Use approved application operations and ordinary Workers/database/queues for the prototype; model extraction and drafting are bounded and optional. Tier 6 is only needed if an approved workload requires incompatible native parsing or other Linux dependencies. No always-on container is required for the proposed demo. Provide a manual entry fallback when a model or parser is unavailable.

## Meeting and funded pilot

Show the prototype with fictional material, let Bulisa introduce a new discrepancy, then ask what existing software does, which step consumes staff time, what would make the evidence trustworthy, and who performs and approves the work. If useful, propose a paid pilot with a named practitioner, a defined sample batch, agreed format, deliverables, usage ceiling, timeline and review meetings. Measure time to review, exceptions caught, false flags, source traceability and reproducibility. Discuss the fee and funding before promising a deployment. Confirm whether a firm-approved environment or customer-supplied provider accounts are required.

Real firm or client data requires the firm's permission, an agreed data-processing and security review, approved providers, access boundaries, retention, export and deletion terms. Keep test data fictional until those arrangements are complete. A pilot approval does not authorize public use of the firm's name, logo, case details or Bulisa's endorsement.

## Acceptance and parallel work

Demonstrate fresh import, field provenance, exact variance, duplicate review, correction history, revised brief and export using synthetic data. Verify role isolation, safe handling of missing/unreadable evidence, concurrent corrections, duplicate uploads, no fabricated sources, and recovery when AI is unavailable. Distinguish local demo, funded pilot and deployed production evidence. Continue the independent [commercial cleaning template](commercial-cleaning-space-template-plan.md) in parallel; prioritize funded, agreed deliverables while reusing platform capabilities across both verticals.
