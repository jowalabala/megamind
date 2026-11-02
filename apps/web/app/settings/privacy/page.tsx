import { appendAuditEvent } from "@mm/audit";
import { memberRepo } from "@mm/db";
import { revalidatePath } from "next/cache";
import { requireMemberContext } from "../../../lib/context";
import { db } from "../../../lib/db";
import { TopBar } from "../../top-bar";

export const dynamic = "force-dynamic";

async function setCapture(formData: FormData) {
  "use server";
  const ctx = await requireMemberContext();
  const optOut = formData.get("optOut") === "true";
  await db().withTenant(ctx.tenantId, async (tx) => {
    await memberRepo.setCaptureOptOut(tx, ctx.member.id, optOut);
    await appendAuditEvent(tx, ctx.tenantId, {
      actorType: "member",
      actorId: ctx.member.id,
      action: optOut ? "member.capture_opted_out" : "member.capture_opted_in",
      targetType: "member",
      targetId: ctx.member.id,
    });
  });
  revalidatePath("/settings/privacy");
}

export default async function PrivacyPage() {
  const ctx = await requireMemberContext();
  const optedOut = ctx.member.captureOptOut;

  return (
    <>
      <TopBar tenantName={ctx.tenant.name} email={ctx.user.email} />
      <main>
        <h1>Your privacy</h1>
        <div className="card">
          <h2>What Master Mind keeps</h2>
          <ul>
            <li>Tasks your agents log: a title, a summary and links to the work (PRs, emails).</li>
            <li>Outcomes of that work, such as whether CI passed or an email got replies.</li>
            <li>
              With the local bridge: one-line summaries of your agent&apos;s steps (which tool,
              which file and lines, which command), never file contents or tool output.
            </li>
            <li>
              If your workspace connects GitHub: pull request titles and descriptions (cleaned the
              same way) and metadata such as files changed, reviews and CI results. Never code. If
              you link your GitHub account and opt out, your pull requests aren&apos;t imported.
            </li>
            <li>
              Secrets (API keys, passwords) and personal data (emails, phone numbers, card numbers,
              teammates&apos; names) are removed before anything is stored. Raw payloads are
              encrypted and deleted after 30 days.
            </li>
          </ul>
          <h2>Who sees it</h2>
          <ul>
            <li>
              Teammates&apos; agents can find this history when they search. They see your name only
              if you share a team and your visibility setting allows it; otherwise your team, or
              just &ldquo;a teammate&rdquo;.
            </li>
            <li>
              While your agent is working, teammates see that it&apos;s active (the tool and the
              repository; the branch only within your team), and nothing about how long or how much.
            </li>
            <li>
              If your agent and a teammate&apos;s change the same files at the same time, both of
              you are told, so you can coordinate before a conflict.
            </li>
            <li>
              Your agent can only open a channel with a teammate&apos;s agent if you both approve
              it. Channel messages are cleaned like everything else and kept with the team&apos;s
              history.
            </li>
            <li>Sessions marked private are never shown to anyone else.</li>
            <li>
              If your workspace connects HubSpot, sequences, marketing emails and deals you own are
              credited to you (matched by your work email). For sequences and emails only counts are
              kept (replies, meetings, clicks, unsubscribes); for deals, the stage and whether it
              was won. Nothing about the contacts themselves is kept, and deal amounts aren&apos;t
              read.
            </li>
            <li>
              Admins can upload outcomes from a spreadsheet (CSV). Rows credited to you name your
              work email; titles are cleaned like everything else. If you&apos;ve opted out, rows
              for you are skipped.
            </li>
            <li>
              If your workspace connects Slack, Master Mind sends you direct messages (approvals,
              skill updates), finding you by your work email. It reads nothing in Slack.
            </li>
          </ul>
          <h2>What it never does</h2>
          <ul>
            <li>Show per-person failure rates or leaderboards.</li>
            <li>Credit you by name on a shared practice unless you choose to be credited.</li>
          </ul>
        </div>
        <h2>Capture</h2>
        <div className="card">
          <p>
            Capture is <strong>{optedOut ? "off" : "on"}</strong> for you.{" "}
            {optedOut
              ? "Anything your agents send is dropped before it is stored."
              : "Your agents' work helps the team learn what works."}
          </p>
          <form action={setCapture}>
            <input type="hidden" name="optOut" value={optedOut ? "false" : "true"} />
            <button type="submit">
              {optedOut ? "Turn capture back on" : "Opt out of capture"}
            </button>
          </form>
          <p className="muted">
            Opting out stops new capture immediately, including tasks already sent but not yet
            processed. To delete what was already stored, ask an admin to remove you: that erases
            your data everywhere, including raw copies and the data lake.
          </p>
        </div>
      </main>
    </>
  );
}
