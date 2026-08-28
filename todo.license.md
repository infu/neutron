# Neutron license rewrite plan

**Working date:** 2026-08-20

This document is the requirements ledger, drafting outline, review protocol,
and completion checklist for the coordinated Neutron licenses. It is not a
license and grants no rights.

The resulting texts are professional engineering drafts, not a substitute for
review by counsel qualified in copyright, patent, open-source, and contract
law in the jurisdictions where Neutron will be distributed or operated.

The original goals below describe the NPL and the modification-and-sharing
NSAL lineage. They do not imply modification or redistribution grants in the
separate source-inspectable `LICENSE.APP.USE` alternative added on 20 August
2026; that license states its narrower grants directly.

## Deliverables

- `LICENSE`: **Neutron Public License, Version 1.0**
  (`LicenseRef-Neutron-Public-License-1.0`), covering the Kernel and other
  software whose application notice selects it.
- `LICENSE.APP`: **Neutron Sovereign Application License, Version 1.1**
  (`LicenseRef-Neutron-Sovereign-Application-License-1.1`), permitting
  modification and sharing while limiting every Production Use, including a
  Sovereign User's private Production Use, to a Qualifying Sovereign System.
- `LICENSE.APP.1.0`: exact preservation copy of the former NSAL 1.0 text for
  already-published packages; it is not the default for new apps.
- `LICENSE.APP.USE`: **Neutron Sovereign Application Use License, Version 1.0**
  (`LicenseRef-Neutron-Sovereign-Application-Use-License-1.0`), providing
  Complete App Source for inspection while reserving modification,
  redistribution, sublicensing, and operation-for-another rights and limiting
  Production Use to a Qualifying Sovereign System.
- `LICENSE.GPL-3.0`: unchanged official GPLv3 reference text.
- `LICENSE.NPL-0.2`: unchanged preservation copy of the superseded NPL draft.
No custom license may exceed **675 physical lines**. The official GPLv3
reference in this repository is 674 lines. If a draft exceeds the cap,
reorganize definitions, remove repetition, and consolidate remedies rather
than shrinking readability.

## Non-negotiable goals

### G1. Real copyright and patent permission

Each license must affirmatively grant the rights needed to run, study, copy,
modify, build, distribute, and, where applicable, operate the covered software
over a network. It must distinguish copyright, patent, and trademark rights.

### G2. Strong reciprocal source protection

Recipients of source or executable forms must retain the license and receive
the preferred form for modification. Modified covered code must remain under
the same license. Object-code distribution must include, or provide durable
no-charge access to, Complete Corresponding Source.

For Neutron, Complete Corresponding Source must account for:

- backend and frontend source rather than only generated/minified output;
- package manifests, dependency locks, and applicable license notices;
- managed-memory schemas, immutable lineage, and migration modules;
- interface definitions and capability declarations;
- build, package, compiler, and install scripts/configuration;
- ordinary manifests, locks, and non-secret inputs needed to follow the supplied
  build and installation instructions without reproducing a user's combined Wasm;
- any authorization material or installation information intentionally needed
  to install a modified build, excluding a user's private secrets; and
- the exact source changes used by a network-operated modified version.

### G3. Browser compilation is a protected user freedom

When Neutron compiles packages into whole-canister Wasm in the user's browser,
the user must be able to inspect the selected packages, their versions and
available source/license information, controllers, and material compatibility
or data-loss warnings. Hashes and build records may remain optional product
integrity features, but they are not license conditions or user duties.

The license must protect the user's ability to select source packages, compile
or obtain platform-valid replacement Wasm, and install it without a DAO,
maintainer, registry, signature service, or provider approving that choice.
Private browser assembly must require no publication of source, modifications,
package composition, combined Wasm, hashes, records, or compliance evidence.

### G4. User sovereignty, not controller-count purity

The legal test is whether the Sovereign User retains a direct and effective
User Upgrade Path. A Neutron may have additional controllers, recovery
services, agents, custodians, or DAO-controlled principals when the user
knowingly chooses or retains them.

The mere existence of another controller is not Daoization. Daoization occurs
when a distributor, provider, DAO, or other third party makes the user's
ability to inspect, compile, install, replace, or reconfigure the whole Wasm
depend on its proposal, vote, signature, secret, allowlist, continued service,
or permission.

The license must:

- prohibit hidden or mandatory third-party vetoes;
- require disclosure of known controllers and deployment-specific authorities;
- permit user-selected additional controllers;
- protect a user's right to add or remove controllers using their independent
  authority;
- distinguish platform Controller Authority from Kernel-mediated User
  Authorization and govern each according to its actual power;
- let a disclosed and removable pre-NPL third-party authority remain after a
  warning at the first reasonable interactive opportunity, without a consent log;
- permit the disclosed Self-Controller to establish the user's first direct
  external Controller Authority;
- distinguish package governance from control of an installed deployment;
- protect users from liability when their own later configuration changes the
  controller set or software; and
- allow temporary bootstrap authority only when a usable handoff occurs before
  the provider represents the deployment as user-sovereign.

### G5. Kernel neutrality and app equality

The Kernel is neutral infrastructure. Its app-facing functions must be general
Capabilities or narrow Kernel Administrative Components.

The main license must require:

- materially equal Capability access for similarly situated apps;
- objective, documented technical, security, privacy, resource, compatibility,
  and user-consent conditions;
- no privilege based on author, publisher, sponsor, signature, registry,
  governance body, commercial relationship, or competition with a maintainer;
- security use of app and package identity under neutral rules for integrity,
  isolation, consent, routing, dependencies, and state compatibility;
- user-selected trust policy without maintainer-selected favoritism;
- ordinary products to remain separately identifiable Applications;
- interactively selected bundled apps to be rejectable, and pre-handoff starter
  apps to be disclosed and promptly removable, allowing safe dependency order;
- no hidden system-app status, exclusive capabilities, or irremovable defaults;
- defined, inspectable, user-selectable default roles whenever a default exists;
- a narrow administrative-component exception; and
- functional anti-evasion when privileged product behavior is moved to a
  helper, service, plugin, package, or nominally separate app.

### G6. Independent Application licensing remains possible

Because Neutron compiles the Kernel and app backends into one actor, the main
license needs an explicit Application Assembly Exception. A separately
identified app does not become NPL-covered solely because Neutron compiles,
links, wraps, stores, or installs it in the same Wasm.

The exception must not cover:

- modifications to NPL-covered Kernel code;
- code that incorporates a licensable portion of the Kernel beyond documented
  interfaces and generated neutral adapters; or
- a nominal app/helper used to evade Kernel-neutrality duties.

Each app keeps its own license. A distributor of a combined Wasm must provide
the source and notices required by every applicable license.

### G7. Downstream rights must survive

Each recipient must receive rights directly from the relevant licensors.
Sublicensing must not be necessary. A distributor may not impose legal or
technical restrictions that contradict the license. Valid downstream grants
must survive an upstream licensee's termination.

### G8. Proportionate enforcement

The licenses must include notice/cure/reinstatement machinery, deliberate
violation handling, patent-defense boundaries, and survival of downstream
rights. Temporary outages, good-faith security response, platform-wide
failures, and user-directed changes must not create immediate irreversible
termination when promptly cured.

### G9. Ordinary legal protection

Both licenses need:

- contributor copyright and patent grants;
- preservation of notices and marking of modifications;
- no implied trademark license;
- no warranty and limitation of liability to the extent permitted by law;
- severability, no waiver, entire-license construction, and headings rules;
- exact version-selection rules;
- a rule allowing verbatim copies of the license text while requiring renamed
  modified license texts; and
- a concise application notice.

### G10. The app license is deliberately use-restricted

The Application license protects a natural person's private Production Use
without a qualification or compliance burden. A person that operates the app
for another may do so only in a Qualifying Sovereign System satisfying the fixed
Kernel Sovereignty Standard. NPL 1.0 is a safe harbor for Kernel-term text, not
a mandatory Kernel license.

It must also provide a bounded exception for development, testing, CI,
interoperability work, migration, archival preservation, and good-faith
security research outside a Qualifying Sovereign System, provided that the app
is not offered there for ordinary production use or used to hold ordinary
third-party user data.

This is an intentional field-of-use restriction. The app license must not call
itself OSI Open Source or Free Software. Recipients must be told that it is
likely incompatible with GPL-only code unless the relevant copyright holders
separately authorize the combination.

A natural person may select public or private packages, compile, install,
modify, run, recover, and replace them in that person's own deployment without
investigating or proving qualification and without publishing source or keeping
compliance records. An upstream violation or independent user change does not
terminate that private permission. This does not authorize operating for
another, multi-user hosting, durable third-party tenancy, or coordinated evasion.

## Non-goals

- Do not edit, fork, or present the GNU GPLv3 text as a modified GPL. Its
  official text permits verbatim copying but says changing it is not allowed.
- Do not call either custom license “GPL-compatible” without an external legal
  and ecosystem compatibility determination.
- Do not use the SPDX identifiers `NPL-1.0` or `NPL-1.1`; SPDX already assigns
  them to the Netscape Public License.
- Do not force a Sovereign User to keep only one controller or forbid a
  voluntarily selected recovery arrangement.
- Do not give a DAO or maintainer a veto over user-selected Wasm merely because
  it governs an official package or repository.
- Do not make an ordinary app NPL-covered merely because the compiler assembles
  it into the same actor.
- Do not weaken managed-memory release rules or imply that destructive
  reinstall is an ordinary app upgrade.
- Do not publish ordinary app archives, change update-source contents, change
  the Dispenser/starter set, or touch production canisters in this phase. Local
  higher-version app candidates and their automatically generated legal/source
  metadata may be built and tested, but remain blocked on the synchronized
  production release gates below. The compatible Kernel successor and apps are
  published as one catalog set, not as ordered rollout phases. The private
  Kernel v0.3.7 GPL bridge is still immutable and unpublished; never rebuild or
  reuse version 307 for new bytes.

## Main-license table of contents

0. Scope, acceptance, and construction
1. Definitions
2. Copyright and patent grants; private use
3. Providing copies, source, executables, and network access
4. Non-production development
5. User Deployments and the User Upgrade Path
6. Package governance and Daoization
7. Kernel neutrality and Application equality
8. Applications, Combined Forms, and the assembly exception
9. Downstream rights and prohibited additional restrictions
10. Patents
11. Compliance, cure, termination, and enforcement
12. Warranty and liability
13. Versions and miscellaneous terms
14. Application notice

## App-license table of contents

0. Scope, sovereignty standard, NPL safe harbor, and construction
1. Definitions and the Qualifying Sovereign System test
2. Copyright and patent grants
3. Production Use and private users
4. Development, testing, security, and recovery
5. Copyleft, packages, source, and network operation
6. Assembly with Kernels and independent dependencies
7. Downstream rights and prohibited additional restrictions
8. Patents
9. Compliance, cure, termination, and enforcement
10. Warranty and liability
11. Versions and miscellaneous terms
12. Application notice

## Clean-room drafting method

1. Preserve the official GPLv3 and superseded NPL texts as immutable references.
2. Extract legal functions and product requirements into this ledger without
   copying GPL prose.
3. Draft definitions once and use them consistently; avoid synonyms for
   operative terms.
4. Tie every “must” to a defined licensed act or managed-deployment trigger.
5. Separate affirmative grants, reciprocal source duties, sovereignty duties,
   Kernel-neutrality duties, exceptions, and remedies.
6. Use an explicit cross-license assembly rule for the one-actor architecture.
7. Test clauses against clean initialization, browser compilation, manual
   package installation, official updates, whole-Wasm replacement, app removal,
   Dispenser handoff, self-controller operation, additional controllers,
   migrations, and third-party app development.
8. Run independent reviews against the same frozen requirements.
9. Resolve every blocker/high finding in the text or record why the requirement
   changed.
10. Check defined-term usage, section references, line limits, whitespace, and
    the final repository diff.

## Independent review assignments

- **Copyleft/legal mechanics reviewer:** grant, scope, source duties, patents,
  downstream rights, restrictions, termination, disclaimers, and internal
  contradictions.
- **Neutron architecture reviewer:** browser compiler, one-actor assembly,
  package source, managed memory, controller mechanics, Dispenser handoff,
  update flows, and current product fit.
- **Adversarial reviewer:** DAO/controller loopholes, sham apps/helpers,
  subjective standards, impossible duties, user-caused state, and enforcement.
- **Application ecosystem reviewer:** Qualifying Sovereign System test,
  development exception, app copyleft boundary, combined Wasm, license
  propagation, and non-sovereign-use restriction.
- **Editorial reviewer:** defined terms, duplicate rules, cross references,
  readability, professional tone, and the 675-line caps.

## Independent review record

Five independent read-only reviewers completed an initial review and a focused
regression pass. Their blocker/high findings were resolved in the drafts or,
where license prose cannot settle enforceability, moved to the external-counsel
gate below.

- The copyleft/legal review drove the direct grants, whole-work copyleft,
  source duties, installation information, patent coverage, successor
  obligations, cure/reinstatement, downstream survival, Licensor covenant, and
  intended-beneficiary language.
- The architecture review drove protected browser assembly, managed-memory
  lineage, self-controller treatment, activation handoff, state-safety checks,
  starter app treatment, the one-actor boundary, and neutral-platform boundary.
- The adversarial review closed the self-owned-deployment, split-actor,
  non-sovereign-label, mandatory-DAO, hidden-controller, provider-controller,
  sham-UUP, sham-helper, artificial-dependency, and temporary-outage paths.
- The app-ecosystem review made the sovereignty test self-contained and
  license-name-neutral. NPL 1.0 is a textual safe harbor; a compatible later NPL
  needs no App-author action, and other terms may qualify by their legal effect.
  Bare permissive licenses are insufficient without enforceable supplementary
  sovereignty terms. The review also protected private users, data recovery,
  bounded development, independent dependencies, and downstream patent rights.
- The editorial review produced the consolidated 0–14 and 0–12 structures,
  eliminated circular definitions and stale terms, checked internal references,
  and checked normalized GPLv3 textual proximity.
- A production-fit regression review removed legal hash, installed-record,
  registry, click-through, and user-remediation duties; protected incidental
  runtime serving; and kept security identity and controller-bootstrap rules.

## Implementation and release prerequisites

The private GPL-only v0.3.7 bridge implements package/deployment integrity
records and related UI, but it has not been published and is not an NPL release.
Those records may remain product safety and recovery features; neither license
makes them a permission condition or asks a user or app author to maintain them.
Before applying NPL/NSAL notices to production package bytes, complete and verify:

- Complete Corresponding Source for the Kernel backend and preferred frontend
  source, ordinary manifests/locks, notices, schemas, migrations, and functional
  build and install instructions, supplied once by the Kernel provider;
- **Implemented locally:** automated ordinary-app packaging includes the exact
  governing license, concise application notice, complete derived third-party
  notice corpus, and a closed Complete App Source snapshot without asking an
  author to hand-write hashes or a deployment record;
- **Implemented locally:** source-discoverable production apps use standard
  installed legal paths and a generator-produced Complete App Source gzip
  sidecar at `<app>/.neutron/sources/<sha256>.source.v1.msgpack.gz`. Their
  record binds the provider's certified HTTPS URL, and the publisher validates
  and atomically uploads source, package, and release pointer. Packages contain
  no source bytes, archive-only paths, or feature markers, so production
  v0.3.5/v0.3.6 and the compatible private v0.3.7 candidate can prepare them in
  one **Upgrade all** batch with the compatible Kernel successor. Users do not
  publish source or maintain a registry. The optional
  embedded-source envelope and its fail-closed filter remain available
  separately. Review of the existing public `/mo/**` source surface remains
  separate;
- review whether the optional public deployment record and live-module hash UI
  still justify their package-list disclosure, canister storage, and cycle cost;
  simplify or remove them only in a higher-version, state-compatible Kernel
  release with the normal production gates;
- convenient static Kernel license/source/build-install materials and installed
  app license/source visibility, with no click-through, assent receipt, public
  registry, content-addressed legal store, or per-installation history;
- documentation and tests for the self-controller plus direct external
  controller escape path, including controller removal, full-User-Authorization
  risk disclosure, and warning of preexisting third-party authority;
- conformance tests for one-user scope, unofficial package compilation,
  whole-Wasm replacement, app removal, equality, handoff, and source retention;
  these tests must not introduce KYC, telemetry, a legally required Wasm hash,
  or a mandatory source/compliance cache inside every canister;
- preservation of the exact preceding production Kernel archive and an actual
  manual upgrade through that version's browser UI, proving both Kernel memory
  roots, installed app state, authorizations, controllers, provenance,
  activation state, and user settings survive;
- a coherent application notice and license inventory for every first-party
  component incorporated into a newly covered executable; if incorporated
  GPL-only components are not relicensed in that release, it is a GPL
  transition release and must not be represented as NPL-covered; and
- the selected workspace boundary: NPL for `neutron-cli`,
  `neutron-compiler`, `neutron-provision`, and `neutron-security`; Apache-2.0
  for `neutron-design-system`, `neutron-motoko-capabilities`,
  `neutron-scripts`, `neutron-tools`, and every `support/*` workspace; exact
  upstream composite terms for `neutron-motoko-wasm`; and NSAL for ordinary
  Applications. Embedded packages and third-party components retain their own
  terms; and
- the repository's production memory, versioning, package, publication, and
  verified no-op postflight rules for every package whose bytes later change.

The exact v0.3.7 archive does not contain the archive-only install filter. The
production cutover does not depend on that filter: packages with
`update_source` use provider-hosted source, standard installable legal paths,
and no package or record feature marker. Immutable production v0.3.5 and v0.3.6
and the compatible private v0.3.7 candidate can prepare the Kernel successor
and app releases together, so the catalog must publish the intended latest set
atomically for one **Upgrade all** action without a Kernel-first timing window.
The marker remains only for a manual-only or explicitly embedded package, which
those old Kernels safely reject and which is not eligible for this simultaneous
cutover. The working-tree implementation does not retroactively alter v0.3.7.

The private v0.3.7 qualification below remains useful compatibility evidence,
but production users on v0.3.5 or v0.3.6 do not have to install it as an
intermediate release. Both released predecessors may select the compatible
successor and app set in the same **Upgrade all** transaction.

The current private bridge archive is exactly:

```text
apps/kernel/kernel.v0.3.7.neutron
bytes: 1924034
sha256: aaf329e5d526f4b5a436c440ac21a245b068172c6e4e2d6dc07696ecadc60f7d
```

Exact archived v0.3.5 and v0.3.6 compiler/PocketIC upgrade lanes pass against
this candidate. The final qualification suite also passes against the current
generator and candidate binding. Its exact checked-in evidence is:

```text
apps/kernel/certified-assets-qualification-receipt.json
bytes: 400532
file_sha256: 210cf8d2eb9b8aa15c2a6fe461fcdae2dfa8ab58e684e72da4848f080f8e97a9
status: passed
receipt_sha256: c4efd19145bba944182b54fc975f03ebc8e3a10e5a3f4708f10a9dfb5495df95
qualified_raw_wasm_sha256: b32e71f3a3e69a462fc5ef58a1099b7dc3c504ad854585ad33e120ccc6723ab0
qualified_transport_wasm_sha256: ac6fce5cbfa905b3d6fcde6107eeb857fda38e74033d473c5ce639ba076af1be
```

Manual upgrade gates using the archived predecessor browser frontends remain
pending. Passing qualification does not provide GPL Complete Corresponding
Source or establish redistribution rights for the bundled `icblast@4.3.0`
bytes. Do not publish an update or change the Dispenser, starter package set,
production update-source contents, source offers/archives, or production
canisters. Those later releases require their own complete checks above.

Until those items and the external-counsel gate are complete, these texts must
not be represented as proof that the current product or a package is compliant.

## Acceptance gates

- [x] `LICENSE` implements G1-G9 and follows its table of contents.
- [x] `LICENSE.APP` implements G1-G3 and G6-G10 as applicable.
- [x] Both licenses use original drafting and do not modify GPLv3 text.
- [x] The main license allows user-selected additional controllers.
- [x] Daoization is defined by loss of independent user upgrade control, not by
      the mere existence of a DAO or another controller.
- [x] Kernel Capability access is app-neutral and anti-evasion is functional.
- [x] Security-relevant app identity remains permitted under app-independent
      rules and cannot be used as a proxy for publisher favoritism.
- [x] The app license protects private personal use, restricts operation for
      another to a Qualifying Sovereign System, and has a bounded test exception.
- [x] The one-actor Application Assembly Exception is consistent in both texts.
- [x] Private and unofficial inputs remain usable without package records,
      public source publication, or a legally required Wasm hash.
- [x] Optional integrity hashes and deployment records are product features,
      not license conditions or user/app-author compliance duties.
- [x] Every operative capitalized term is defined or ordinary-language usage is
      unmistakable.
- [x] Every internal section reference resolves.
- [x] Each license is at most 675 physical lines.
- [x] Independent reviewers have reported and their material findings are
      resolved or recorded.
- [x] `git diff --check` or an equivalent untracked-file check passes.
- [x] The private Kernel bridge intentionally changed release version 306 to
      307, generated manifest/package metadata, and produced the exact v0.3.7
      archive recorded above; format 3 and memory v3/v1 stayed unchanged.
- [x] No production update-source content, source offer/archive, starter set,
      Dispenser, production canister, or package publication was changed.

## External counsel gate

**Status: open.** Drafting and engineering review cannot make the following
legal determinations.

Before calling either text legally final or publishing package bytes under it,
obtain written review addressing at least:

- copyright ownership and authority to relicense every first-party component;
- compatibility with all bundled third-party and formerly GPL-only material;
- copyright enforceability of managed-deployment and Kernel-neutrality terms;
- patent-grant and defensive-termination scope;
- intended-beneficiary and specific-performance provisions, if any;
- consumer, unfair-contract, warranty, export, sanctions, and governing-law
  requirements in relevant jurisdictions;
- whether the app license's field-of-use restriction and bounded private-user
  protection have the intended effect;
- whether the implemented Apache-2.0 boundary for app-facing SDK, runtime,
  build-script, and design-system code fully prevents independently licensed
  Applications from incorporating NPL-only material;
- whether independently lawful execution can bypass provider-operated
  field-of-use conditions and whether the no-click, conduct-based provider
  covenant is enforceable in each intended jurisdiction;
- whether a user-selected extra ICP controller can technically eliminate the
  user's control and what disclosure or product safeguard is required; and
- whether either license should be submitted to SPDX, OSI, Blue Oak, or a
  recognized license-review forum under a non-conflicting name.

## Execution log

- [x] Official GPLv3 saved unchanged as `LICENSE.GPL-3.0` and verified against
      the repository's historical GPL text.
- [x] NPL v0.2 preserved unchanged as `LICENSE.NPL-0.2`.
- [x] Requirements and initial clause outlines frozen in this document.
- [x] Main license first draft completed.
- [x] App license first draft completed.
- [x] Independent review completed.
- [x] Review fixes applied.
- [x] Mechanical validation completed.
- [x] Exact archived v0.3.5 and v0.3.6 compiler/PocketIC bridge lanes passed.
- [x] The final v0.3.7 candidate qualification suite passed against the current
      generator and binding; the exact receipt and its file, internal, raw-Wasm,
      and transport-Wasm hashes are recorded above.
- [x] The private v0.3.7 bridge records `source: not-provided`; no source
      archive or public source offer was added.
- [x] The v0.3.7 archive remains private; the publisher, production
      update-source contents, Dispenser, starter set, and production canisters
      were not changed.
- [x] Ordinary-app legal/source metadata generation is automated locally;
      private users do not publish source or maintain a registry merely to build
      or install a package.
- [x] Exact v0.3.5/v0.3.6 embedded browser compiler/assembler closures compile
      the private v0.3.7 Kernel plus all 14 clean production app archives in one
      real-Chromium batch with zero compiler errors or compatibility diagnostics;
      v0.3.7 parser/batch fixtures and a v0.3.5-based single **Upgrade all**
      service session cover the same clean envelope.
- [x] Production app packages use exact provider-hosted, generator-produced gzip
      source, standard installed legal paths, and no archive-only markers.
      Publisher receipt v2 atomically accounts for source, package, and release
      pointer.
- [x] Retain the closed marker/filter for explicit embedded-source packages that
      immutable v0.3.5/v0.3.6/v0.3.7 safely reject; source manifests require no
      author-maintained feature field.
- [ ] Qualify and publish the state-compatible Kernel successor and compatible
      production app set together, then verify one **Upgrade all** path from the
      supported predecessors and the receipt-v2 no-op postflight. Do not use a
      Kernel-first publication window. Rerun the automated legacy-compiler batch
      and manual archived-browser live deployment/state/controller-preservation
      gates against the exact successor archive once it exists.
- [x] Hullshift's demo release gate now requires the fast deterministic exact
      catalog, solvability, quality, type, package, and memory checks. Optional
      fixed-point level-design ablation and the offline Python suite are not
      production publication gates.
- [ ] Verify and carry the exact independent terms for Gemma's pinned remote
      browser runtime, model, and checkpoint before publishing its Apache-2.0
      first-party app candidate. Apache-2.0 on Neutron's code does not license
      those external assets.
- [ ] Run the manual archived-browser upgrade gates for the supported v0.3.5
      and v0.3.6 predecessor lanes.
- [ ] Before any conveyance, provide the GPL Complete Corresponding Source;
      `source: not-provided` is not source and is not a GPL source offer.
- [ ] Establish and document redistribution rights for the exact bundled
      `icblast@4.3.0` bytes, or remove or replace them and requalify the changed
      candidate.
