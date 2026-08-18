# Neutron Public License v0.2 review

**Review date:** 2026-08-14

**Historical scope:** This file reviews the preserved
[`LICENSE.NPL-0.2`](./LICENSE.NPL-0.2) text and repository state before the
Version 1.0 rewrite. It does not review the current `LICENSE` or `LICENSE.APP`;
the current requirements, review record, and release gates are in
[`todo.license.md`](./todo.license.md).

**Release recommendation:** **Do not release or publish Neutron under NPL v0.2.**

This is a technical and license-drafting review, not legal advice. A lawyer who
specializes in open-source and software licensing should turn the chosen policy
into final license text and review the complete copyright and dependency
inventory before release.

## Executive conclusion

The sovereignty goal is coherent and unusually well matched to Neutron's
architecture. Neutron is a personal cloud computer in one ICP canister: one
human owner, a replaceable Kernel, separately identified Applications, and a
generic capability system intended to treat ordinary Applications equally.
The distinction in the draft between governance of a package and governance of
a particular user's computer is especially important.

The preserved [NPL v0.2 text](./LICENSE.NPL-0.2), however, is not yet a usable replacement for
GPLv3. It is a set of architectural and deployment requirements titled “Core
Sovereignty and Kernel-Neutrality Provisions.” It contains no affirmative
copyright license grant and does not define which code it covers, who receives
rights, or what recipients may copy, modify, run, or distribute. It also omits
the source-code, downstream, patent, notice, termination, warranty, and
liability machinery expected in a public software license.

There are four immediate release blockers:

1. **No rights are granted.** The text imposes requirements but never grants
   permission to use, reproduce, modify, create derivative works, distribute,
   sublicense, or operate the software.
2. **The operative scope is undefined.** Key terms, regulated acts, covered
   works, responsible parties, cure process, and remedies are absent.
3. **The current product does not satisfy several mandatory NPL promises.** In
   particular, the graphical product does not accept arbitrary raw Wasm, offer
   a general backup/export before replacement, or display the applicable
   license and corresponding source for every installed component.
4. **The repository is in a mixed and potentially incompatible state.** The
   root license says NPL, while 28 first-party `package.json` files, one Mops
   manifest, ten app-level `LICENSE` files, and a Dispenser UI notice still say
   GPLv3.

NPL v0.2 should therefore be treated as a **policy draft or sovereignty
specification**, not as the license under which a release is made.

## Neutron model used for this review

I reviewed the root README, all Markdown documents under `doc/`, the current
license, package metadata, app-level license files, and the implementation
surfaces identified by the documentation.

The relevant product model is:

- One Neutron is one ICP canister intended for one human owner. Multiple
  principals can be credentials for that same owner; Neutron does not model
  teams, roles, or per-user tenants.
- The compiler assembles one Kernel and up to 255 ordinary app backends into a
  single Motoko actor and Wasm module. Apps are not separate canisters.
- The Kernel is the trusted control plane. It owns authorization, app install
  review, capability mediation, browser isolation, certified assets, recovery,
  and the checked, state-preserving whole-actor update transaction.
- Ordinary apps are separately identified `.neutron` packages. Their authority
  is derived from a closed manifest and an app-scoped capability plan. The
  compiler and Kernel are deliberately app-neutral.
- Managed stable memory is durable user data. Released memory roots and schema
  lineage must be restored or explicitly migrated; destructive reinstall is
  not a production upgrade path.
- The production Dispenser temporarily provisions a canister, then removes its
  Kernel authorization and controller authority. A completed Dispenser-created
  Neutron retains its own canister principal as its IC controller, while the
  human becomes Kernel-authorized through activation.
- The owner can review and install manual or repository `.neutron` packages,
  reject official updates, remove ordinary apps subject to dependency order,
  and replace the Kernel with another valid Kernel package.

These conclusions follow principally from [Product Model And User
Story](./doc/product-model-and-user-story.md), [Compiler And Actor
Assembly](./doc/compiler-and-actor-assembly.md), [Security
Model](./doc/security-model.md), [Kernel Backend
Runtime](./doc/kernel-backend-runtime.md), [Kernel Frontend
Runtime](./doc/kernel-frontend-runtime.md), [App Package
Format](./doc/app-package-format.md), [Managed Memory Migrations And
Uninstall](./doc/memory-migrations-and-uninstall.md), and [Dispenser And
Provisioning](./doc/dispenser-and-provisioning.md).

## The GPL premise needs refinement

GPLv3 is not generally a license “for software over hardware.” It is a broad
software copyright license. Its specifically hardware-oriented provision is
the section 6 requirement to provide Installation Information when object code
is conveyed in a “User Product,” a term framed around tangible personal
property and dwellings. GPLv3 also says that interaction with software over a
network, without transfer of a copy, is not by itself conveying.

AGPLv3 adds a network-use source obligation for a modified program operated for
remote users. Neither GPLv3 nor AGPLv3 guarantees that a person controls the IC
controller set for a particular canister, can replace that canister's entire
Wasm without a provider, or receives an app-neutral Kernel.

The new objective is therefore real, but different from ordinary copyleft:

> **GPL/AGPL primarily protect software freedoms and source availability. NPL
> is trying to protect deployment sovereignty and platform neutrality for a
> particular personal cloud computer.**

That goal can support a custom license, but it does not remove the need for a
complete copyright grant and conventional license mechanics.

## Blocking findings

### 1. The text does not grant a copyright license

The draft begins by defining a Sovereign User and immediately imposes
deployment rules. It never says that a recipient may use, reproduce, modify,
prepare derivative works, display, perform, distribute, or sublicense a covered
work. It does not identify an initial licensor, covered software, or a notice
that places a work under the license.

Copyright owners generally hold the exclusive rights to reproduce, adapt, and
distribute their work. Conditions only become useful after the license grants
the relevant permission. As written, a downstream recipient cannot determine
what permission NPL supplies.

At minimum, a full license needs:

- a precise Covered Work and Modified Work scope;
- a worldwide, royalty-free, non-exclusive copyright grant;
- an express right to run and operate the software, including on a network;
- rights to reproduce, modify, distribute, and provide modified versions;
- a patent grant and a considered patent-retaliation rule;
- an application notice that says which files or packages are NPL-covered; and
- a clear statement of which conditions attach to which granted acts.

### 2. The text lacks the mechanics of a public software license

Only **Sovereign User** is substantively defined. The following capitalized or
operative terms are undefined or insufficiently bounded: Personal Canister
Environment, Controller Identity, Administrative Authority, User-Controlled
Authority, User Data, Application, Kernel, Kernel Package, Distribution,
End-User Distribution, Capability, Kernel Administrative Component,
Governance Body, Targeted Deployment Governance, Underlying Platform,
provider, distributor, and maintainer.

The text also leaves out:

| Missing element | Consequence |
| --- | --- |
| Covered Work and modification rules | It is unclear whether NPL covers the Kernel, compiler, frontend, app packages, generated actor, or all of them. |
| Regulated acts and responsible actor | “Must” is not tied consistently to copying, distribution, deployment, hosting, maintenance, or provision of a service. |
| Source-code obligation | NPL does not actually require source disclosure or define Corresponding Source. It could provide fewer source rights than GPLv3. |
| Network/deployment trigger | A provider may operate modified NPL software without conveying a copy; the draft does not clearly say what act activates its duties. |
| Modification and downstream terms | Recipients do not receive an automatic license, and modified versions have no stated licensing or notice rule. |
| Additional-restriction rule | A distributor could theoretically add terms that defeat the stated rights. |
| Termination, notice, cure, and reinstatement | There is no proportionate response to accidental or temporary noncompliance. |
| Downstream survival | A distributor's violation could put an innocent user's rights in doubt. |
| Warranty disclaimer and liability limit | Authors and distributors lack conventional risk allocation. |
| Patent and trademark rules | Patent rights and use of the Neutron name are unspecified. |
| Version selection | It is unclear whether a work is under one exact NPL version, later versions, or a steward-selected version. |
| Severability and conflict rules | One invalid or impossible clause may destabilize the whole instrument. |
| End-user enforcement | It is unclear whether the Sovereign User can enforce promises made for their benefit or only a copyright holder can act. |

The current text combines three things that should be consciously separated or
layered:

1. a copyright and patent license;
2. obligations for distributing or operating a covered deployment; and
3. a technical conformance specification for a “Sovereign Neutron.”

If the conformance specification remains separate, the license should
incorporate an immutable, exact version—not a mutable web page—and say which
requirements are conditions of which grants.

### 3. Stock Neutron does not currently meet the complete NPL contract

The product strongly implements the neutrality half of the draft, but it does
not yet implement the whole sovereignty interface the draft makes mandatory.

| NPL area | Current Neutron behavior | Assessment |
| --- | --- | --- |
| One Sovereign User / No Co-Tenancy | The documented invariant is one canister for one human owner, with no teams, roles, or per-user partitions. | **Aligned**, provided every authorized principal belongs to that same person. |
| Exclusive User Authority | The Dispenser retires itself before handoff. Other provisioner configurations can retain a deployer or backup controllers, and Settings permits additional full-authority principals/controllers. | **Conditional.** Every retained identity must be controlled solely by the same person before ordinary use. |
| Self-controller escape | A completed Dispenser canister retains only itself as IC controller. Self-upgrades are requested through the currently installed Kernel. | **Unresolved and likely insufficient under section 59.** A broken or hostile Kernel can mediate the alleged escape. A durable, direct user-controlled controller path is the clearer design. |
| Whole-Wasm Replacement | The graphical installer accepts `.neutron` packages and supports a special Kernel-package replacement compiled through Neutron's assembler. The offline CLI can emit Wasm. | **Not compliant.** This is not graphical installation of arbitrary platform-valid raw Wasm selected by the user. |
| Equal alternative installation | Manual File/URL `.neutron` installation exists and unsigned packages are allowed, while official updates are discovered through the configured source. | **Partially aligned**, but no arbitrary-Wasm alternative exists, so it cannot be as accessible as an official update. |
| Backup/export before replacement | Managed memory and uninstall preserve state, but no general, restorable whole-environment export is documented. Stable Store explicitly defers export/import and backups. | **Not compliant.** |
| License/source inspection | Settings exposes deployment, app, capability, authorization, controller, update, and some repository provenance information. Format-3 app manifests and the installed registry do not carry an applicable license. Repository `source` is optional provenance, not complete Corresponding Source. | **Not compliant.** |
| Inspect all authorities | Settings exposes Kernel-authorized principals and IC controllers. | **Partial.** “Known Administrative Authorities” is undefined and indirect authority is not modeled as one inspectable inventory. |
| Replacement modes | The checked app/Kernel transaction and destructive provisioner reinstall are separate flows. Reinstall is deliberately not a production upgrade. | **Not compliant as written.** The UI does not offer the range of platform-supported raw-Wasm modes contemplated by the draft. |
| DAO/package governance | Update sources and repositories can recommend packages, but an owner reviews and may reject them. Publishing does not install an update. | **Aligned with the intent.** |
| Kernel neutrality | Capabilities have closed, generic schemas; app authority is app-scoped; ordinary app identity is not a compiler policy input. | **Strongly aligned.** |
| Bundled apps | Starter apps remain separately identified and ordinary; app uninstall exists. Dependency rules can require dependents to be removed first. | **Mostly aligned**, but “removable” should explicitly allow safe dependency ordering. |
| No privileged apps / no Sherlocking | The Kernel literal ID is the only structural special case; generic features are intended to become capabilities usable by independently developed apps. | **Strongly aligned.** |

Related evidence appears in [App-Isolated Stable
Store](./doc/app-isolated-stable-store.md), [Package
Updates](./doc/package-updates.md), [Provisioning
System](./doc/provisioning-system.md), [Production
Provisioning](./doc/production-provisioning.md), [Repository Setup
Manifests](./doc/repository-setup-manifests.md), [Kernel Capability
Inventory](./doc/kernel-capability-inventory.md), and [Open Questions And
Design Gaps](./doc/open-questions-and-design-gaps.md).

This mismatch matters even if the authors intend to implement the missing
features later. Sections 47 and 63 say the duties apply for as long as covered
software is installed and to every maintained end-user release. Releasing the
license first would declare current official distributions nonconforming on
their face.

### 4. The repository currently states conflicting licenses

Changing the root `LICENSE` does not make the rest of the current tree
coherent:

- The root [`package.json`](./package.json) and 27 other first-party
  `package.json` files still declare `GPL-3.0-only`.
- [`packages/neutron-motoko-capabilities/mops.toml`](./packages/neutron-motoko-capabilities/mops.toml)
  still declares `GPL-3.0-only`.
- Ten app directories contain full GPLv3 license copies: Agent, Chess,
  Contacts, Gemma, Hello, Kernel, Kitchen Sink, VFS, Wagyu, and Wallet.
- The Dispenser UI still renders “Powered by Neutron Kernel — GPLv3” in
  [`support/dispenser/src/index.tsx`](./support/dispenser/src/index.tsx).
- The README says Neutron is “fully open,” which would need qualification if
  NPL retains its current use and deployment restrictions.
- The `.neutron` format has no authoritative `license_id`, license-text hash,
  or complete Corresponding Source field.

The claim that there are no contributors means the authors can ordinarily
offer **their own** copyrightable work under a new license, assuming all rights
were retained or validly assigned. It does not relicense third-party code,
generated inputs with separate terms, copied material, or dependencies. Those
need an inventory. The repository already includes material under other
licenses, including Apache-2.0 and third-party MIT/BSD/ISC/Unicode notices.

Relicensing also does not retroactively withdraw GPL rights from people who
legitimately received older GPL-covered copies. Preserve the old tags,
archives, notices, and source required for those releases. Describe the change
as a new license for a new release, not as cancellation of the old grants.

The mixed state is particularly risky because Neutron compiles Kernel and app
modules into one actor. GPLv3's whole-work and additional-restriction rules may
conflict with conveying a combined Wasm containing GPL-only app code alongside
NPL code that imposes deployment and user restrictions. Exact consequences
depend on copyright ownership, what is conveyed, and whether components form
one work, so counsel should review this before any combined artifact is
distributed or installed for another person.

### 5. The Kernel/Application boundary is not licensed

Neutron's architecture depends on independently developed Applications, yet
the draft never says whether compiling an Application into the same actor:

- makes the Application or complete generated actor NPL-covered;
- leaves the Application under its own compatible license;
- is permitted through an explicit linking/assembly exception; or
- creates different obligations for backend modules, frontend assets, shared
  Motoko dependencies, generated wrappers, schemas, and migrations.

This is not an edge case; it is the standard installation model. A strong
whole-program copyleft rule could force every installed app under NPL and
undermine the stated independent app ecosystem. A broad exception could allow
modified Kernels to evade the license by moving prohibited behavior into a
nominal helper or app—the exact behavior section 222 tries to prevent.

A full draft needs a deliberate Application exception plus an anti-evasion
test based on function and control. It should also define Corresponding Source
for Neutron packages. At minimum, consider source for the Kernel/app modules,
frontend, manifest, managed-memory schemas and migrations, lock lineage, build
scripts, compiler inputs, capability declarations, and the information needed
to reproduce and install the relevant Wasm.

## High-priority drafting issues

### NPL as written is not an open-source license

If the current restrictions are retained, NPL should not be described as open
source in the OSI sense. The single-natural-person limitation, exclusion of
collectives from important deployment roles, mandated product architecture,
and technology-specific canister/Wasm conditions conflict with at least these
Open Source Definition criteria:

- no discrimination against persons or groups;
- no discrimination against fields of endeavor;
- license not specific to a product; and
- technology neutrality.

Source visibility and permission to modify do not by themselves make a license
open source. “Source-available sovereignty license” or a similarly precise
description would be more accurate unless the restrictive rules move to a
separate certification or trademark policy.

This is a policy choice, not automatically a defect. The project must choose
which promise is non-negotiable: OSI-open licensing for every fork, or mandatory
sovereignty behavior by every covered distributor/deployer. One copyright
license cannot fully guarantee both when the desired behavior restricts who
may deploy the software and how it must be deployed.

### Copyright conditions and operational promises are conflated

The license needs to identify the legally relevant trigger for each duty. For
example, duties might apply when someone distributes a Covered Work, provides
a managed deployment to another person, or operates a modified version as a
network service. Merely saying that a provider “must” maintain a behavior does
not clearly connect that behavior to the granted copyright rights.

Some requirements govern configuration or conduct that may not always involve
an exclusive copyright right. Their enforceability varies by jurisdiction and
may require an explicit agreement or conformance/trademark mechanism in
addition to copyright conditions. Specialist counsel should design this part;
copying GPL wording and adding operational restrictions would not solve it.

GPLv3 section 7 is also a reason **not** to publish the current provisions as
“GPLv3 plus NPL restrictions.” Restrictions of this kind are not among GPLv3's
ordinary permitted additional terms, and recipients may be entitled to remove
further restrictions or the distributor may be unable to convey the combined
work.

### Authority and human-life cases need explicit decisions

The one-person rule matches the product, but the draft creates unresolved
cases:

- a user intentionally adds a trusted recovery person or jointly controlled
  multisignature;
- a guardian or accessibility delegate acts solely for one person's benefit;
- a minor uses a Neutron;
- the user loses capacity or dies and an estate needs to recover durable data;
- a user wants a professional recovery service without giving it unilateral
  authority;
- a CI, test, demo, archive, or development deployment has no living Sovereign
  User; or
- a user later chooses collaboration that the original distributor does not
  control.

The conditions should primarily constrain licensors, distributors, and
providers, not make an end user's voluntary later action terminate their own
rights or put an upstream distributor in unavoidable breach. Decide whether
limited agents, guardianship, succession, threshold recovery, and non-production
deployments are exceptions. If they are intentionally forbidden, state the
data-recovery and succession consequence plainly.

### Absolute and subjective duties are hard to satisfy

Terms such as “functioning and practical,” “unconditional,” “technically
valid,” “prominently,” “reasonably available,” “substantially as accessible,”
“similarly situated,” “materially equal,” “general-purpose,” and “ordinary
end-user functionality” need objective tests or carefully bounded standards.

Other difficult cases include:

- temporary platform outages, security incidents, browser incompatibility, or
  a user-installed modification;
- platform-level controller or emergency authority that section 124 intends to
  exempt;
- a replacement Wasm that is syntactically valid but exceeds subnet limits,
  lacks required IC exports, or cannot preserve existing state;
- what constitutes a useful and restorable backup, including encryption and
  keys;
- whether a generic, protocol-driven provider catalog is an allowed capability
  implementation or a prohibited maintainer-controlled allowlist;
- how safe dependency ordering interacts with an app's removability; and
- which launcher, workspace, Settings, tray, provider driver, and recovery UI
  functions are narrow Kernel Administrative Components.

Publish a versioned conformance suite alongside objective definitions. Do not
require telemetry or a maintainer backdoor to prove compliance; that would
contradict the sovereignty goal.

### No cure or impossibility rule

“For as long as installed” makes every temporary failure a potential breach.
The license should distinguish deliberate structural noncompliance from a
transient defect and include notice, a reasonable cure period, automatic
reinstatement where appropriate, and protection for innocent downstream users.
It also needs rules for legal or technical impossibility, platform-wide
changes, force majeure where appropriate, and user-caused configuration.

### The short name collides with an existing license

SPDX already uses `NPL-1.0` and `NPL-1.1` for the **Netscape Public License**.
Do not put `NPL-0.2` or a future `NPL-*` value into SPDX `license` fields as if
it were a recognized Neutron identifier.

Use a unique full name and, until any identifier is formally registered, an
SPDX custom expression such as:

```text
LicenseRef-Neutron-Public-License-0.2
```

Use that form only in metadata that accepts SPDX custom references; where a
package manager requires its own custom-license convention, follow that
convention and point unambiguously to the bundled license text. Renaming the
short form would reduce ecosystem confusion.

## Strong parts worth preserving

The review should not obscure what the draft gets right:

- It expresses Neutron's one-human/one-personal-environment model accurately.
- It treats controllers, emergency keys, required co-signatures, and indirect
  recovery authority as one practical authority problem instead of relying on
  labels.
- It distinguishes general ICP/NNS platform governance from targeted control
  of a particular user's canister.
- It permits DAOs to govern and recommend packages while denying them automatic
  authority over an installed personal computer.
- It requires meaningful whole-environment replacement rather than merely
  publishing source that the user cannot deploy.
- It captures the repository's core architecture: Kernel capabilities are
  infrastructure; ordinary Applications are removable products; capability
  policy must not depend on app authorship, sponsorship, or competition.
- Its anti-evasion and anti-Sherlocking principles address real ways a nominally
  neutral platform can privilege first-party apps.

These provisions are a good foundation for a **Neutron Sovereignty
Specification**. They need precise definitions, tests, and legal machinery
before they can serve as license conditions.

## Recommended licensing paths

### Path A: AGPLv3 plus a sovereignty specification

Use AGPLv3 for the code and place “Sovereign Neutron” requirements in an
independent conformance specification, certification program, trademark policy,
official-distribution policy, and provider contracts.

Advantages:

- established copyright, patent, source, network-use, termination, and warranty
  terms;
- recognized open-source status and compatibility expectations; and
- much lower custom-license ambiguity.

Tradeoff: an AGPL-compliant fork may ignore the sovereignty specification if it
does not use protected branding or enter a relevant contract. Choose this path
if “open source” is non-negotiable and the official Neutron identity, rather
than every fork, is what must guarantee the product model.

### Path B: a complete custom NPL

Use a lawyer-drafted custom license that makes defined distribution and hosted
deployment permissions conditional on the sovereignty requirements. Describe
it as source-available/non-open-source unless and until an appropriate authority
concludes otherwise.

Advantages:

- sovereignty and neutrality duties can bind covered deployments directly; and
- the rules can model canisters, controllers, whole-Wasm replacement, and
  neutral application capabilities explicitly.

Tradeoffs:

- custom-license interpretation, adoption, compliance, and compatibility costs;
- likely incompatibility with GPL-only code and many ecosystems' license
  allowlists; and
- no guarantee that every operational condition is enforceable through
  copyright alone.

Choose this path if mandatory behavior by third-party deployments is more
important than OSI-open status. This appears closest to the stated NPL goal,
but the current v0.2 text is not sufficient for it.

### Path C: dual licensing

Offer the authors' code under an established open-source license and NPL, with
NPL also acting as the route to official conformance or additional rights.
This can support different adopters, but the open-source route necessarily
allows recipients to avoid NPL-only behavioral restrictions. It is useful for
branding, certification, support, or commercial rights—not for forcing every
fork to remain sovereign.

Do not try a fourth path of “GPLv3 plus these extra restrictions” without a
carefully designed exception and compatibility analysis. That is the most
likely approach to create a license contradiction.

## Minimum content for the next NPL draft

If Path B is chosen, NPL v0.3 should be a complete new draft, not a few clauses
appended to v0.2. Counsel should address at least:

1. License name, steward, exact version, application notice, and version-choice
   rule.
2. Definitions for Covered Work, Source, Modified Work, Application, Kernel,
   generated actor, Distribution, Deployment, provider, operator, Sovereign
   User, Controller, authority, capability, and platform.
3. Copyright and patent grants covering use, network operation, reproduction,
   modification, distribution, and sublicensing.
4. Exact triggers for source, distribution, hosted-deployment, and maintained
   release obligations.
5. Corresponding Source and installation information adapted to Neutron's
   compiler, package, migration, capability, and controller model.
6. The one-user, authority handoff, replacement, backup/export, and graphical
   sovereignty requirements with objective conformance criteria.
7. Kernel neutrality, capability equality, bundled-app, administrative-component,
   dependency, provider-catalog, and functional anti-evasion definitions.
8. An explicit rule for separately licensed Applications and the generated
   combined actor.
9. Automatic downstream grants, no additional restrictions, notices,
   modification marking, and preservation of third-party notices.
10. User-choice, development/test, temporary-failure, platform-change,
    impossibility, guardianship/recovery, and succession rules.
11. Enforcement rights, notice, cure, reinstatement, downstream survival, and
    the status of Sovereign Users as intended beneficiaries.
12. Warranty disclaimer, limitation of liability, severability, governing-law
    considerations, patents, trademarks, and export/sanctions considerations.

The normative license and specification should use immutable versioned text.
Material changes require a new version; do not silently edit a released
license while retaining its identifier.

## Product work required before claiming NPL v0.2-style compliance

Independently of legal drafting, the documented product would need at least:

1. **A direct user-controlled recovery/controller path.** Ensure the human has
   an escape that does not depend solely on cooperation from the currently
   installed Kernel. Define credential backup and recovery without leaving a
   provider-controlled key.
2. **A graphical arbitrary-Wasm flow.** Accept local and documented remote raw
   platform-valid Wasm, show its hash and compatibility/data-loss warnings, and
   permit unsigned/non-registry modules. Keep this distinct from the safe
   `.neutron` package transaction.
3. **A real backup/export contract.** Define scope, format, encryption, keys,
   restorability, managed-memory roots, Stable Store, assets, app metadata,
   authorization, and what cannot be restored across incompatible Wasm.
4. **Installed license and source metadata.** Extend the closed package manifest
   and installed registry with immutable license identity, license-text digest,
   notices, source location, and preferably a reproducible source/build
   reference. Display them for the Kernel, distribution, and every app.
5. **An authority inventory.** Define and display controllers, Kernel-authorized
   credentials, recovery paths, self-controller implications, and any known
   indirect deployment authority without pretending that general platform
   governance is deployment-specific control.
6. **A conformance suite.** Test provider retirement, direct user recovery,
   unsigned raw-Wasm replacement, alternate-source parity, backup/restore,
   license/source inspection, generic capability admission, removal of bundled
   apps, and rejection of updates without loss of control.

Arbitrary-Wasm installation is deliberately more dangerous than a checked
`.neutron` update. The UI should preserve both paths and label their guarantees:
the checked path preserves the managed-memory contract; the sovereignty path
permits an intentional whole-environment escape after explicit warnings and a
backup opportunity.

## Repository cutover checklist

Do not perform a piecemeal public cutover. Before the first release under the
chosen license:

1. Confirm ownership/assignment of all first-party code despite the stated
   absence of contributors; inventory dependencies, copied code, generated
   inputs, fonts/assets, and third-party notices.
2. Freeze and preserve the last GPL release, its exact source, package
   archives, notices, and build evidence.
3. Obtain legal review of the final license and its GPL/AGPL/Apache and app
   ecosystem compatibility.
4. Choose a unique license name and SPDX `LicenseRef`; add an unambiguous
   copyright and application notice.
5. Update the root, every workspace manifest, Mops metadata, app-level license,
   UI string, README, documentation, package manifest, archive notices, and
   generated/published metadata in one reviewed release change.
6. Decide the Kernel/Application exception before combining differently
   licensed packages into one Wasm.
7. Audit every persistent memory root affected by new registry/manifest fields.
   Add immutable forward migrations only if persistent schema really changes;
   otherwise retain and prove restoration of the existing memory version.
8. Bump every production app release version whose packed bytes change. Build
   each app with its complete workspace `package` command and run its release
   and migration tests, including clean initialization and every supported
   production upgrade path.
9. Review exact archives before production publication. Publish through the
   repository's checked update workflow, then publish the exact same bytes a
   second time and require the documented all-`unchanged`, `batch_id: null`
   receipt.
10. Update the Dispenser starter package list separately only if newly
    dispensed Neutrons should receive the new packages. Never use destructive
    reinstall as an application upgrade mechanism.

Until those steps are complete, keep NPL labeled as a draft and do not publish
new production package bytes that claim it.

## Primary external references

- [GNU General Public License version 3](https://www.gnu.org/licenses/gpl-3.0.en.html)
  — especially sections 0, 2, 5, 6, 7, 10, 11, 15, and 16.
- [GNU Affero General Public License version 3](https://www.gnu.org/licenses/agpl-3.0.en.html)
  — especially section 13's remote-network source provision.
- [GNU GPL FAQ](https://www.gnu.org/licenses/gpl-faq.en.html) — FSF guidance on
  combined works, additional terms, and releasing author-owned code under
  different licenses at different times.
- [The Open Source Definition](https://opensource.org/osd) — especially
  criteria 5, 6, 8, and 10.
- [17 U.S.C. § 106](https://uscode.house.gov/view.xhtml?req=granuleid%3AUSC-prelim-title17-section106&num=0&edition=prelim)
  — exclusive rights in copyrighted works. Other jurisdictions differ.
- [ICP management canister reference](https://docs.internetcomputer.org/references/management-canister/)
  — controller-gated code installation and install/upgrade/reinstall modes.
- [SPDX Netscape Public License 1.0 entry](https://spdx.org/licenses/NPL-1.0.html)
  — the existing `NPL-1.0` short identifier and name collision.
- [SPDX license-expression specification](https://spdx.github.io/spdx-spec/v2.3/SPDX-license-expressions/)
  — the `LicenseRef-` mechanism for licenses not on the SPDX License List.
