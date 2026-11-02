# Data Processing Agreement (draft)

> **Draft for legal review. Not legal advice and not ready to sign.** It describes what the
> product actually does, so counsel can turn it into an agreement. Items marked **[counsel]**
> need a decision or wording from a lawyer.

Between **[Customer]** ("Customer", the controller) and **Master Mind [legal entity]**
("Master Mind", the processor), as part of the pilot agreement dated **[date]**.

## 1. Subject and duration

Master Mind processes personal data only to provide the service described in the pilot
agreement: capturing work done by the Customer's people and their AI agents, judging its
outcomes, generating practices ("skills") for human approval, and coordinating agents. The DPA
lasts as long as Master Mind holds Customer data.

## 2. Data and people

|                   |                                                                                                                                                                                                                                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Data subjects** | The Customer's members (employees, contractors) who sign in or whose work is captured                                                                                                                                                                          |
| **Personal data** | Name, work email, sign-in identifiers; GitHub and HubSpot user ids; Slack user id; summaries of work (titles, one-line agent actions, PR titles and descriptions, sequence, email and deal names) after redaction; outcomes of work, aggregated in the product |
| **Not processed** | Source code contents, email bodies, contact records from HubSpot (only counts), deal amounts, special category data. Secrets and personal data inside captured text are removed before storage                                                                 |
| **Purpose**       | Providing the service; nothing else. No training of models, no sale, no advertising                                                                                                                                                                            |

## 3. Instructions

Master Mind processes Customer data only on the Customer's documented instructions, which are
this DPA, the pilot agreement, and the Customer's settings in the product (connected systems,
capture opt-outs, retention). Master Mind tells the Customer if it believes an instruction breaks
data protection law.

## 4. Confidentiality

Only Master Mind's founders have access to production systems, under confidentiality
obligations, through SSO with MFA, and only to operate and support the service.

## 5. Security

Master Mind maintains the measures in its security policies, including: tenant isolation in the
database (row-level security tested on every table) and the data lake (a separate encryption key,
role and namespace per customer); encryption in transit and at rest; redaction of secrets and
personal data before storage; human approval before any skill is used or any agent-to-agent
channel opens; an append-only audit log; logging and threat detection in AWS; quarterly tested
restores. **[counsel: attach as Annex 2]**

## 6. Subprocessors

| Subprocessor                             | Purpose                     | Location                  |
| ---------------------------------------- | --------------------------- | ------------------------- |
| Amazon Web Services (incl. Bedrock)      | Hosting, storage, AI models | United States (us-east-1) |
| WorkOS                                   | Sign-in                     | United States             |
| Slack (only if the Customer connects it) | Notifications to members    | Per the Customer's Slack  |

Master Mind gives 30 days' notice before adding or replacing a subprocessor; the Customer may
object on reasonable grounds. **[counsel: objection remedy]**

## 7. Data subject rights

The product lets the Customer's admins remove a member and erase what they captured (database at
once, raw data and lake within minutes, backups of the lake within 11 days), and lets each member
opt out of capture. Master Mind helps with other requests within 10 business days.

## 8. Personal data breaches

Master Mind notifies the Customer without undue delay, and within 72 hours, after becoming aware
of a personal data breach affecting Customer data, with what is known, what is being done, and a
contact. Updates follow as facts become known.

## 9. Deletion at the end

When the Customer's admin deletes the organization in the product (or asks in writing), Master
Mind deletes all Customer data after a 7-day grace period, or sooner on written request:
database records including the audit log, raw payloads, the data lake, and the customer's lake
encryption key (destroyed by AWS 7 days after scheduling, after which remaining encrypted copies
can't be read). Database backups expire within 30 days. Master Mind revokes its access tokens for
the Customer's HubSpot and Slack and confirms completion in writing.

## 10. Audits

Master Mind provides its security policies, threat model, restore drill reports and, when
available, its SOC 2 report. On-site audits: once a year with 30 days' notice, at the Customer's
cost. **[counsel]**

## 11. Transfers

Data is stored and processed in the United States. **[counsel: SCCs or other transfer mechanism
for EU/UK personal data, if the Customer has EU/UK members]**
