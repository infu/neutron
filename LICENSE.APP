# Neutron Sovereign Application License

Version 1.0, 15 August 2026

License reference: LicenseRef-Neutron-Sovereign-Application-License-1.0

## License category

This License limits provider-operated Production Use to a Qualifying Sovereign System while giving a Sovereign User a
simple private-use protection that requires no compliance investigation, publication, registry, or record. That
field-of-use condition is intentional. This License is not an OSI-approved Open Source or Free Software license. It is
generally incompatible with GPL-only, AGPL-only, and other material whose license forbids further or field-of-use
restrictions, absent separate permission from all relevant rights holders.

## Preamble

This License lets an Application be studied, changed, shared, and improved while reserving provider-operated Production
Use for a personal software system where the user can choose packages, compile a private personal system, replace the
Kernel, and receive fair treatment for Applications.

It permits assembly with an independently licensed Kernel. When an NPL governs the Kernel, this License coordinates with
that NPL's Application Assembly Exception. Compiling an Application into the same canister executable as a Kernel does
not change either component's license.

The License Category and Preamble explain classification and purpose. The numbered sections state the operative terms.

## Table of contents

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

## 0. Scope, sovereignty standard, NPL safe harbor, and construction

### 0.1 Application Work

This License applies to App Source carrying the notice in section 12, each non-source form and package of that App
Source, and every App Modification. Each is an **Application Work**.

### 0.2 Kernel sovereignty standard and NPL safe harbor

“Kernel Sovereignty Standard” means the three numbered Qualifying Kernel Terms requirements below and conditions 2
through 6 of the Qualifying Sovereign System test in section 1. It is a fixed minimum; a license name, compatibility
claim, certification, package origin, or registry listing cannot replace the stated rights and behavior.

“Neutral Underlying Platform Service” means general-purpose compute, storage, network, gateway, routing, identity, or
consensus infrastructure that applies uniform rules without deployment-specific discretion and does not choose or veto
the software installed in a particular user's system.

“Kernel Control Surface” means the Kernel and a component or service that performs, controls, authorizes, or gates
Kernel assembly, installation, complete-Wasm replacement, controllers, upgrades, or Capabilities. It does not include an
Application or package merely because the Kernel processes it; a user's package selection, browser runtime, or device
merely executing a supplied tool; a passive build input or independently licensed dependency merely consumed by a tool;
or a Neutral Underlying Platform Service. It also excludes an optional user-selected Controller Authority or recovery
service that is disclosed, freely removable without its cooperation, not required, supplied, controlled, or coordinated
by a Kernel Provider, not essential to the User Upgrade Path, and no third-party veto.
A nominally separate component remains inside when it exercises a privileged control-plane function or is used to evade
the Standard.

“Kernel Provider” means a person that Conveys a Kernel or supplies, controls, operates, provisions, administers, or holds
deployment-specific authority over its Kernel Control Surface for another person. Authority or conduct of an affiliate,
agent, contractor, or coordinated actor is attributed to that person; dividing functions does not avoid this definition.
It excludes a Sovereign User acting only for that user's deployment, a person acting solely as an Application author or
distributor, a supplier of a Neutral Underlying Platform Service, and a person acting solely through an optional
authority or service excluded from the Kernel Control Surface above.

“Governing Kernel Terms” means the licenses and enforceable terms actually governing the Kernel Control Surface and the
Kernel Provider's provider conduct. Multiple compatible instruments may operate together. A broader permission does not
excuse a conflicting restriction or a provider duty that no enforceable instrument supplies.

“Qualifying Kernel Terms” means Governing Kernel Terms that:

1. lawfully give the Sovereign User durable rights and the Complete Kernel Source and installation materials reasonably
   needed to inspect, run, copy, modify, build, package, install, and replace the Kernel Control Surface, including any
   patent or anti-circumvention permission actually necessary for those acts and controlled by a relevant rights holder;
2. bind each Kernel Provider, while acting in that role, not to defeat the User Upgrade Path and to satisfy the
   one-user-scope, controller-disclosure, no-veto, Capability-neutrality, and Application-separation duties within
   conditions 2 through 6 that its conduct or authority can affect; and
3. preserve the user's installed-version source, modification, installation, control, and recovery rights despite
   termination or provider succession, and give affected users direct enforcement of those rights and affected App
   Licensors direct enforcement of Capability neutrality and Application equality where applicable law permits.

The terms need not use the NPL name. Their legal effect controls. This License, an Application license, voluntary
behavior, documentation, or a product label cannot supply missing Kernel rights or bind a Kernel Provider.

“NPL 1.0” means the unmodified Neutron Public License, Version 1.0, identified as
LicenseRef-Neutron-Public-License-1.0 and distributed with the Kernel.

A “Compatible Later NPL” is one exact later numbered Neutron Public License that the Kernel's application notice is
authorized to select, that is authentically published by the steward named in that notice, and whose own operative text
identifies this License and expressly states that it preserves or strengthens every part of the Kernel Sovereignty
Standard. Each later version stands alone; recognition is not transitive and does not relicense earlier code.

NPL 1.0 and each Compatible Later NPL conclusively satisfy only the textual requirements of Qualifying Kernel Terms when
that exact NPL lawfully governs the Kernel and binds its Kernel Provider. Source delivery and actual system behavior
remain independent requirements. Application authors and users do not select, approve, register, or document the
Kernel's license. A later NPL without the express compatibility statement may still qualify by its actual legal effect.

Apache-2.0, MIT, and similar permissive terms alone do not bind a Kernel Provider to the continuing sovereignty duties
and therefore do not qualify by name. They may govern genuine independent components or form part of Governing Kernel
Terms when additional enforceable terms supply the missing provider duties without conflict.

“Kernel Materials” means the Kernel's governing license terms, Complete Kernel Source or its no-charge location, and
ordinary build and installation instructions, made available by or for the Kernel Provider once for the Kernel release
through a package, ordinary file, or stable network location. No per-installation copy, digest, signature, public
or append-only registry, content-addressed store, on-canister record, actor dossier, or deployment history is required. A Sovereign User
and a person acting solely as an App Licensor, App Contributor, or Application distributor or operator have no duty to
create, verify, publish, host, or retain Kernel Materials.

Governing Kernel Terms do not govern independent Application material solely because it is assembled with a Kernel, and
this License does not govern an independent Kernel solely because of that assembly. Section 6 preserves these boundaries.

### 0.3 Offer and responsibility

Each App Licensor offers the permissions in this License to every person and entity. You accept its conditions when You
exercise a permission that would otherwise require authorization. The conditions limit the grants and, where law
recognizes them, are promises exchanged for those grants.

A person that Conveys or Operates an Application Work for another is responsible only for the duties this License places
on that conduct. Kernel qualification and Kernel Materials are evaluated from the Governing Kernel Terms and conduct of
the Kernel Provider. A person acting solely as an App Licensor, App Contributor, Application author, distributor,
package publisher, signer, registry, or operator does not thereby select, warrant, monitor, or document them.

The Sovereign User must have a convenient way to view this License and the Kernel Materials, but no click-through,
signature, digest acceptance, registration, receipt, acceptance record, or repeated notice is required. The user does
not assume a provider's, distributor's, operator's, or App Licensor's duties.

Private Assembly and the private use protected by section 3 require no affirmative acceptance procedure. Nothing reduces
fair use, fair dealing, exhaustion, or comparable rights.

### 0.4 Construction

Definitions apply in singular and plural, and a defined verb includes its ordinary grammatical forms. “Including” is not
limiting. “Must” states a condition; “may” states permission. A specific rule controls a conflicting general rule.
Headings do not limit the text.

## 1. Definitions and the Qualifying Sovereign System test

**App Contributor** means a copyright holder that intentionally places an original contribution under this License. That
contribution is its **App Contributor Version**. **App Licensor** means an App Contributor for rights that App
Contributor can license.

**App Source** means the form preferred for understanding and modifying an Application. **Executable Form** means a
non-source form, including compiled backend code, WebAssembly (“Wasm”), generated JavaScript, bundled assets, and the
non-source portions of an Application Package.

**App Modification** means a change, adaptation, or new work containing a copyrightable portion of an Application Work.
It excludes an independent Kernel, independent Application, Independent Dependency, documented interface, and neutral
generated adapter merely assembled with the work.

**Application** means separately identifiable software whose practical principal purpose is an end-user product or
service. **Application Package** means a package intended for assembly or installation that contains or identifies an
Application's code, assets, manifest, schemas, migrations, dependencies, and other material. **Combined Form** means an
executable or package set containing an Application Work and a Kernel, other Application, or Independent Dependency.

**Complete App Source** means the preferred source form of the Application Work and the ordinary non-secret materials
used to build and package it. As applicable, it includes application source, interfaces, the Application manifest,
declared Capabilities, released state schemas and migrations, build and package scripts or configuration, ordinary
dependency manifests or lock files, and notices or source that an incorporated dependency's own license requires.

It excludes the Kernel, other Applications, standard compilers and tools, private keys or credentials, User Data,
installed state, personal content or configuration, a user's package composition, generated combined Wasm, and a
private modification not Provided to another. No manually recreated dependency inventory, digest list, dependency
source archive, or byte-for-byte reproduction is required unless another component's own license independently requires
it.

**Complete Kernel Source** means the preferred source for understanding and modifying the Kernel Control Surface and the
ordinary non-secret materials used to build, test, package, and install it. It includes applicable interfaces,
manifests, dependency manifests or locks, required notices, released managed-memory schemas and migrations, scripts,
configuration, and a documented functional installation procedure. It excludes Applications, user-selected packages,
private package composition, generated combined Wasm, private keys, unrelated User Data, and shared infrastructure
secrets. If independent installation requires a credential, these materials are complete only when they include a
user-controlled credential or an equivalent path rather than a shared secret.

**Controller Authority** means a platform-level principal, credential, canister, contract, multisignature, recovery
arrangement, or practical power independent of Kernel-mediated User Authorization that can replace or delete complete
Wasm or change platform controllers. **Self-Controller** means the deployed canister principal acting as Controller
Authority through the Kernel. **User Authorization** means Kernel-level authority to approve administrative operations,
including asking the Self-Controller to act; it is not Controller Authority. Multiple User Authorizations representing
the same Sovereign User are not third-party authorities.

**Similarly Situated Applications** meet the same necessary, proportionate, documented, app-independent technical,
security, privacy, resource, compatibility, and user-consent conditions relevant to a Capability. Authorship, publisher,
funding, signature source, registry, governance, affiliation, and competition do not alone make Applications differently
situated. Identity may support neutral consent, integrity, isolation, routing, resources, dependencies, state, and
migrations, but cannot act as a proxy for favoritism.

**Convey** means to transfer a copy or enable another party to make or receive one. **Operate** means knowingly to
provision or administer an Application Work in another person's personal software deployment, or provide another person
an independent account or tenant using it, while holding sufficient practical control. Control or authority held by an
affiliate, agent, contractor, or coordinated actor is attributed to You; dividing functions does not avoid this
definition. Ordinary communication or collaboration through the Sovereign User's environment is not Operating. Nor is
executing, storing, routing, or replicating code under uniform platform rules without deployment-specific discretion.
**Provide** means to Convey or Operate an Application Work.

**Private Assembly** means a Sovereign User's selection, acquisition, modification, compilation, assembly, installation,
backup, restoration, migration, and use of software solely for that user's personal deployment, including transmission
to a Neutral Underlying Platform Service solely for execution or storage there. Private Assembly is not Conveying,
Providing, or Operating for another person. Communicating or exchanging User Data is not Conveying the software.
Automated availability of runtime or package assets incidental to that personal environment is not Conveying unless the
user affirmatively acts with the purpose of distributing the Application Work itself.

**Recipient** means a person or entity receiving a copy from You or a natural person for whom You Operate an Application
Work. An employee or contractor is excluded only while acting exclusively for You without ordinary personal use or an
independent right to the copy.

A remote contact, collaborator, visitor, or protocol counterparty is not a Recipient merely because they exchange data
through the Sovereign User's environment. They become a Recipient if You give them an independent account, durable
tenancy, personal environment, administrative domain, or deployment managed for their benefit.

**Independent Dependency** means separately authored and identified material that does not contain a copyrightable
portion of the Application Work and interacts through a documented interface or ordinary build boundary. Its own license
remains controlling.

**Kernel** means trusted control-plane software supplying user authorization, Application lifecycle, Capability
mediation, complete-system assembly or installation, recovery, or equivalent infrastructure. **Capability** means a
documented general facility through which a Kernel mediates an Application's access to a protected resource.

**Production Use** means running or operating an Application Work for its ordinary intended functionality or to process,
store, or control non-test data. Activities expressly allowed by section 4 are not Production Use.

**Sovereign User** means the one natural person for whose primary personal benefit a deployed personal software
environment operates. **User Data** means information supplied by, produced for, or lawfully controlled by that person,
including installed state needed for continued use.

**User Upgrade Path** means a documented, effective path under the Sovereign User's control that lets that person
inspect the installed Kernel, source and terms, packages, controllers, and material compatibility or data-loss
warnings; select or build modified, unsigned, unlisted, private, and differently governed complete package sets or
complete Wasm; install or replace the complete Wasm without a deployment-specific third-party approval or secret; and
establish and use a directly controlled platform Controller Authority to reconfigure controllers. It discloses each
essential provider-controlled service or credential and the consequences of replacement, and lets the user employ
user-controlled credentials or a documented export or migration path for essential provider-controlled state. Neutral,
app-independent integrity, state-safety, resource, and authentic-consent checks are permitted. The provider need not
know or predetermine browser-generated Wasm, but must not knowingly substitute software the user did not select.

**Qualifying Sovereign System** means the current, reasonably observable state of a deployed personal software
environment that satisfies every following condition:

1. its Kernel Control Surface is governed by Qualifying Kernel Terms, and each Kernel Provider actually satisfies those
   terms and the conditions below applicable to its conduct or authority;
2. one Sovereign User has the User Upgrade Path, and no other person receives an independent account, durable tenancy,
   personal environment, administrative domain, or ownership interest in the deployment;
3. no provider, governance body, maintainer, signer, registry, Controller Authority, or other third party has a
   mandatory veto over that path;
4. all Controller Authorities, and third-party User Authorizations able to replace complete Wasm or alter controllers,
   known or reasonably knowable to a Kernel Provider are disclosed to the Sovereign User; the Self-Controller acts
   only through user-authorized Kernel operations and is no third-party veto; the user receives a warning matched to
   each third-party authority's power, affirmatively selects it while default-off before that authority is activated,
   and can remove or revoke it through the User Upgrade Path; a preexisting authority is disclosed and warned about at
   the first reasonable interactive opportunity and is removed or revoked if declined; no historical consent or
   retention record is required; a provider may impair the path or authority only on a contemporaneous
   authenticated user request or to the minimum necessary during a documented active compromise for no more than
   seventy-two hours without fresh, specific consent, followed by prompt notice and restoration; and the path remains
   usable;
5. the Kernel uses necessary, proportionate, documented, app-independent conditions to make Capabilities available to
   Similarly Situated Applications on materially equal eligibility, interfaces, review, fees, and admission rules;
6. ordinary products, including the Application Work, remain separately identifiable and removable subject only to
   genuine, documented, non-circular dependency order; no Kernel, coordinated helper, or nominal Application absorbs or
   reserves a favored product, material competing feature, or hidden, exclusive, or identity-based favoritism; and any
   default role is defined, inspectable, user-selectable, replaceable, and open to compatible Similarly Situated
   Applications;
7. the Kernel Provider makes Kernel Materials available, and a person that Conveys or Operates an Application Work makes
   this License, required notices, and Complete App Source available as section 5 requires; the system and Sovereign User
   need not publish or retain compliance evidence; and
8. the system is not merely labeled sovereign while materially failing any condition above.

Equal eligibility does not promise equal user consent, credentials, allocation of an exhausted or exclusive resource,
performance, or outcome. General governance and neutral operation of an underlying network do not create a third-party
deployment veto. An independent breach that does not materially affect the current observable state does not by itself
disqualify that state, but nothing excuses the person responsible or limits a remedy under this License or the Governing
Kernel Terms.

**Security Research** means good-faith investigation of an Application Work intended to find, understand, report, or
remediate a vulnerability without unauthorized use of User Data or avoidable harm.

**You** means the person or legal entity exercising permissions. A legal entity includes entities it controls, is
controlled by, or is under common control with, where control means power to direct management or ownership of more than
half of voting or beneficial interests.

## 2. Copyright and patent grants

Subject to this License, each App Licensor grants You, for the duration of the applicable right, a worldwide,
royalty-free, non-exclusive license under copyright and copyright-like rights to run, study, reproduce, modify, adapt,
make derivative works of, display, perform, Convey, Provide, and otherwise exercise those rights in its App Contributor
Version.

Each App Contributor also grants a worldwide, royalty-free, non-exclusive patent license to make, have made, use, offer,
sell, import, run, modify, Convey, and Provide its App Contributor Version under Essential App Patent Claims it controls
now or later. An **Essential App Patent Claim** is a claim necessarily infringed by a licensed exercise of that App
Contributor Version, alone or in a combination that App Contributor supplied or designed or documented the App
Contributor Version to support. It excludes claims infringed only by Your later App Modification or unrelated
combination.

The grants are irrevocable except under sections 8 and 9. Each downstream Recipient receives rights directly under
section 7; sublicensing is neither granted nor needed. Production Use is limited by section 3.

To the extent law permits, each App Licensor agrees not to assert moral or similar rights solely to prevent licensed
conduct. No trademark, service mark, trade name, logo, publicity, or endorsement right is granted, except accurate
reproduction of required notices.

## 3. Production Use and private users

Except for a Sovereign User's protected private use, a person may Operate an Application Work for another only in a
Qualifying Sovereign System. Packaging, Conveying, and Private Assembly may occur before or without qualification. A
person acting only as an Application distributor need not evaluate a Recipient's present or future system. An operator
may rely in good faith on the Kernel Provider's current disclosures unless the operator knows they are materially false
or caused or controls the defect. An operator acting solely in an Application role does not violate this License solely
because an unknown provider defect means the system did not qualify. After actual knowledge, that protection covers a
safe wind-down or migration but not new or expanded operation until the defect is cured.

A natural person who lawfully receives or independently installs an Application Work may make Private Assembly and
private Production Use in that person's own deployment without investigating, monitoring, proving, or auditing
qualification. The user need not publish source or modifications, keep a package or controller history, create a record,
register anything, run a source service, cure an upstream violation, or migrate merely to preserve permission. Discovery
of an upstream defect or an independent user change does not terminate that private permission. The user may always
inspect, export, recover, migrate, delete, or safely uninstall their own software and User Data.

This protection does not authorize operating for another, multi-user hosting, durable third-party tenancy, or knowing
coordination with a provider to evade this License. It does not excuse the Kernel Provider, Application operator, or
other person responsible for a violation. A compliance request must be directed to the responsible provider or operator,
not to a Sovereign User acting only for that user.

## 4. Development, testing, security, and recovery

In addition to the private use protected by sections 2 and 3, outside a Qualifying Sovereign System You may copy, build,
run, and modify an Application Work as reasonably necessary to develop, review, test, integrate, migrate, archive, or
perform Security Research on that Application Work. Any resulting later use must be independently lawful.

The exception permits automated testing, CI, interoperability testing, authorized attempts to bypass controls in a
lawfully controlled test environment, incident response, forensics, and recovery testing. Use synthetic, deidentified,
or minimum authorized fixture data and delete it when no longer needed.

This section does not permit ordinary operational benefit, an end-user service, production hosting, durable third-party
tenancy, retention of unrelated personal data, avoidable harm, or disguising production as development, beta, classroom,
archival, or research activity.

## 5. Copyleft, packages, source, and network operation

### 5.1 Every copy and App Modification

When You Convey an Application Work, You must provide it under this License, preserve accurate copyright, authorship,
patent, license, and warranty notices, supply this License and required third-party notices, identify each App
Modification with a reasonable description and date, and prominently disclose the Production Use condition.

Every App Modification and work based on the Application Work as a whole must remain under this License, subject to true
aggregates and section 6. You may charge for a copy or service, but must not charge a Recipient again merely to exercise
rights already granted.

### 5.2 Complete App Source

When You Convey App Source, include Complete App Source or a functioning no-charge link to it. When You Convey
Executable Form, supply a retainable copy of Complete App Source with it or provide no-charge network access to copy it.
Including a retainable source copy fully satisfies this section for that copy and creates no continuing hosting duty.
If You use only a link, keep it available while You Convey that version and for three years after the last Conveyance.
No public repository, account, registration, or disclosure to anyone other than a Recipient is required. Source access
must require no broader identification, contract, or payment than executable access.

A person that only forwards an intact package may pass through its included source or upstream source offer without a
separate hosting duty, unless that person knows the offer is materially false or unavailable. After actual knowledge,
stop Conveying, supply the source, or restore the offer. This does not relieve the person whose own conduct created or
controls the offer.

### 5.3 Application package information and private assembly

When You Convey an Application Package, include or identify the Application and version, this License, required notices,
Complete App Source, ordinary dependency manifests or locks, declared Capabilities, and released schemas and migrations.
An ordinary manifest and source tree may satisfy this section, and a packaging tool may generate or supplement the
information. You need supply only accurate materials and facts under Your control.

No App Licensor, App Contributor, Application author, distributor, operator, or Sovereign User must predict, calculate,
approve, publish, register, or retain a future package combination, compiler output, installation payload, combined Wasm,
installed-module hash, Kernel-terms selection, actor evidence, or deployment history. No installed-system legal record,
public registry, content-addressed store, or on-canister compliance record is required. Private Assembly creates none of
these duties.

A Kernel may create optional local integrity, compatibility, migration, or recovery information for product safety. Such
information is not a condition of permission or qualification.

### 5.4 Network operation

When You Operate an Application Work for a Recipient, that Recipient must have a prominent, convenient, no-charge way to
obtain the exact Complete App Source, this License, third-party notices, and any App Modification notice throughout
operation. An unmodified Kernel feature satisfies this condition if You supply the exact materials and do not suppress
the feature. You need not identify or contact Recipients individually, keep a Recipient list, use a public repository, or
continue hosting after operation ends. Section 5.2 separately governs a copy You Convey.

Source for installed or running code may not be embargoed. Exploit instructions, vulnerability analysis, private
credentials, and unrelated security material are not Complete App Source and may be handled through coordinated
disclosure.

## 6. Assembly with Kernels and independent dependencies

You may validate, package, compile, link, wrap, store, install, serve, or assemble an Application Work with a Kernel,
Independent Dependencies, and other Applications before deployment and in a Qualifying Sovereign System.

The Application Work remains under this License. An independent Kernel, Application, dependency, documented interface,
or neutral generated adapter does not become subject to this License solely because of assembly. This License grants no
rights under another component's license.

The exception does not remove this License from an App Modification, code containing a copyrightable portion of the
Application Work beyond a documented interface or neutral adapter, derived assets, or a nominally separate component
used to evade this License.

A Combined Form You Convey must preserve the available legal identities, notices, and licenses of its components and
supply Complete App Source for the Application Work and source required by each other component's license. Byte-level
separation, prevention of compiler inlining, a reproducible executable mapping, build or deployment records, and digests
are not required. Private Assembly is not Conveying a Combined Form.

The Production Use condition restricts only the Application Work, never rights in an independent Kernel. The assembly
exception does not cure incompatibility with GPL, AGPL, or another license.

## 7. Downstream rights and prohibited additional restrictions

Each time You Provide an Application Work, every Recipient automatically receives the section 2 grants directly from
every App Licensor. You are responsible for Your conduct, not policing independent Recipients.

You must not impose a license term, royalty for exercising granted rights, technical restriction, withheld
authorization, or other measure that further limits a Recipient's rights. The Qualifying Sovereign System condition is
part of this License and cannot be removed by an ordinary distributor.

You may not invoke anti-circumvention law or a technological-protection claim to prevent licensed private conduct under
sections 2 and 3, conduct in a Qualifying Sovereign System, or conduct under section 4. To the extent You hold such power,
You waive it for those acts.

You may charge for copies, support, hosting, indemnity, or warranty solely on Your own behalf. Independent contracts may
grant more rights, but only all relevant App Licensors may separately authorize non-sovereign Production Use. No service
agreement binds another App Licensor.

## 8. Patents

If You initiate a patent claim alleging that a licensed exercise of an Application Work infringes, the section 2 patent
grants to You terminate when filed. This does not apply where the allegation is confined solely to Your additions, or to
a defensive counterclaim, a request for non-infringement or invalidity, participation required by law, enforcement of
this License, or a claim directed solely to an independent Kernel, Application, or Independent Dependency.

You may not knowingly Provide in reliance on a patent arrangement protecting only some Recipients. Before Providing,
extend equivalent protection automatically to all downstream Recipients, obtain another lawful basis, or refrain from
Providing.

If You knowingly Provide an Application Work whose licensed exercise necessarily depends on a specific third-party
patent not covered here, give the Recipient a prominent informational notice identifying the claim and available
licensing information.

## 9. Compliance, cure, termination, and enforcement

A **Material Violation** is a failure that materially denies source, downstream rights, the Production Use condition,
required notices, or another condition of a grant. An inadvertent immaterial defect promptly corrected is not a Material
Violation. A responsible provider's knowingly false source or qualification disclosure, concealed conflicting term, or
deliberate lapse of Qualifying Kernel Terms is a Material Violation.

For a first non-deliberate Material Violation, permissions continue during a thirty-day cure period beginning at the
earliest of written notice, actual knowledge, or when You reasonably should know. Cure restores full compliance and
prevents termination. Cure does not retroactively authorize a provider's knowing nonqualifying operation. A Sovereign
User protected by section 3 has no cure, documentation, or migration duty.

A deliberate, concealed, repeated, or uncured Material Violation suspends permissions from the affected App Licensor for
the affected Application Work. When You cure, permissions are provisionally reinstated. Reinstatement becomes permanent
unless the App Licensor gives final written termination within sixty days after cure. A finally terminated party cannot
obtain a new automatic license for the same material without written reinstatement.

A temporary outage, active security incident, or underlying-platform failure is not a Material Violation for up to
thirty days while You did not design or repeat it to evade qualification, take prompt reasonable steps to restore
compliance, preserve independent fallbacks, and accurately notify affected users. A provider-controlled condition beyond
thirty days is not protected. A genuine platform-wide impossibility outside Your control remains protected only while
You document restoration efforts and notify affected users at least every thirty days. This paragraph never excuses
source delivery, a deliberate or repeated deployment veto, or extends section 1's seventy-two-hour limit on provider
impairment of the User Upgrade Path.

During that protected period, an otherwise qualifying system remains a Qualifying Sovereign System solely for
determining permissions under this License.

Termination never ends a license already received by a compliant downstream Recipient. The good-faith user and
data-recovery rights in sections 3 and 4 survive. You must not use Your violation to disable or reclaim the user's
system or User Data.

Every affected Sovereign User and direct package Recipient is an intended beneficiary of source, notice, qualification,
control, and recovery duties. An affected App Licensor is an intended beneficiary of neutrality and Application-equality
duties. To the extent law permits, each may seek an order enforcing those respective duties, including source, notices,
cessation of non-sovereign operation, equal access, or safe data access. This gives no ownership of another person's
intellectual property, infrastructure, secrets, or private data and creates no damages unavailable under law.

An App Licensor's delay or failure to enforce is not a waiver.

## 10. Warranty and liability

“Protected Party” means an App Licensor, App Contributor, or compliant redistributor or operator that has not separately
assumed the relevant obligation in writing.

TO THE FULLEST EXTENT THE LAW PERMITS, EACH APPLICATION WORK IS PROVIDED AS AVAILABLE AND WITH ALL FAULTS. NO PROTECTED
PARTY MAKES A WARRANTY, EXPRESS, IMPLIED, OR STATUTORY, INCLUDING TITLE, NON-INFRINGEMENT, MERCHANTABILITY, FITNESS FOR
A PARTICULAR PURPOSE, SECURITY, ACCURACY, OR UNINTERRUPTED OPERATION. YOU BEAR THE RISK OF USING, MODIFYING, INSTALLING,
OR PROVIDING IT.

TO THE FULLEST EXTENT THE LAW PERMITS, NO PROTECTED PARTY IS LIABLE UNDER ANY LEGAL THEORY FOR LOST DATA, LOST PROFITS,
BUSINESS INTERRUPTION, OR INDIRECT, SPECIAL, INCIDENTAL, EXEMPLARY, PUNITIVE, OR CONSEQUENTIAL DAMAGE ARISING FROM AN
APPLICATION WORK OR THIS LICENSE, EVEN IF ADVISED THAT THE DAMAGE WAS POSSIBLE.

Where law forbids a disclaimer or exclusion, it applies only to the maximum lawful extent. A separate written warranty
or service obligation binds only its provider.

## 11. Versions and miscellaneous terms

Safe-harbor recognition under section 0.2 is exact-version-specific and prospective. It does not recognize another
version, amend or relicense this License or any work, certify a deployment, or create rights before that version's
effective date.

You may reproduce this License exactly. You may adapt its text only if the changed license uses a name and identifier
that are not confusingly similar, states that it is unofficial, and does not imply endorsement.

If a provision is invalid, a court should reform it only as much as needed while preserving its purpose; if that is
unavailable, sever it and enforce the remainder. An external agreement or order does not excuse noncompliance. If
obligations conflict, stop exercising the licensed right to the extent of conflict.

This License is the complete license from each App Licensor except for a separate additional grant. It selects no
governing law, venue, or jurisdiction. Applicable law controls unless relevant parties separately agree without
restricting downstream rights.

## 12. Application notice

Place this notice in source and a prominent file distributed with the Application:

    Copyright [year] [copyright holder]
    Licensed under the Neutron Sovereign Application License, Version 1.0.
    SPDX-License-Identifier: LicenseRef-Neutron-Sovereign-Application-License-1.0
    Provider-operated Production Use is permitted only in a Qualifying Sovereign System.
    Private personal use is protected by sections 2 and 3. See LICENSE.APP.

Do not state that a later version of this License applies unless every relevant App Licensor separately and expressly
grants that choice. Kernel-license qualification is governed by section 0.2 and requires no change to this notice.
