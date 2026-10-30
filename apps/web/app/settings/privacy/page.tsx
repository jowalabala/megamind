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
              Secrets (API keys, passwords) and personal data (emails, phone numbers, card numbers,
              teammates&apos; names) are removed before anything is stored. Raw payloads are
              encrypted and deleted after 30 days.
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
            processed. To delete what was already stored, ask your admin.
          </p>
        </div>
      </main>
    </>
  );
}
