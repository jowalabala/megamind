import { connectionRepo, eq, hubspotSequences, members, sql } from "@mm/db";
import { hubspotConfigFromEnv } from "@mm/hubspot";
import { requireMemberContext } from "../../../lib/context";
import { db } from "../../../lib/db";
import { githubConfig } from "../../../lib/github";
import { slackConfig } from "../../../lib/oauth-state";
import { TopBar } from "../../top-bar";

export const dynamic = "force-dynamic";

const MESSAGES: Record<string, string> = {
  installed: "GitHub is connected. History import starts within a minute.",
  linked: "Your GitHub account is linked. Your pull requests are now credited to you.",
  not_configured: "The GitHub App isn't configured on this server yet.",
  admins_only: "Only admins can connect GitHub.",
  expired: "That request expired or was started by someone else. Try again.",
  no_code:
    "GitHub didn't confirm who you are. The App must request user authorization during installation.",
  github: "GitHub didn't accept the request. Try again.",
  not_your_installation: "Your GitHub account can't access that installation.",
  other_workspace: "That account is already connected to another workspace.",
  hubspot_installed:
    "HubSpot is connected. Sequences, marketing emails and deals are imported within half an hour; results follow as they become final.",
  slack_installed:
    "Slack is connected. Channel approvals and skill updates now arrive as direct messages.",
  hubspot_not_configured: "The HubSpot app isn't configured on this server yet.",
  slack_not_configured: "The Slack app isn't configured on this server yet.",
  hubspot: "HubSpot didn't accept the request. Try again.",
  slack: "Slack didn't accept the request. Try again.",
  already_linked: "That GitHub account is linked to another member.",
};

export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const ctx = await requireMemberContext();
  const { ok, error } = await searchParams;
  const { list, hubspot, slack, sequences, me } = await db().withTenant(
    ctx.tenantId,
    async (tx) => ({
      list: await connectionRepo.listConnections(tx, "github"),
      hubspot: await connectionRepo.listConnections(tx, "hubspot"),
      slack: await connectionRepo.listConnections(tx, "slack"),
      sequences: (
        await tx
          .select({
            n: sql<number>`count(*)::int`,
            final: sql<number>`count(${hubspotSequences.metricsFinalAt})::int`,
          })
          .from(hubspotSequences)
      )[0],
      me: (
        await tx
          .select({ githubUserId: members.githubUserId })
          .from(members)
          .where(eq(members.id, ctx.member.id))
      )[0],
    }),
  );
  const configured = githubConfig() !== null;
  const isAdmin = ctx.member.role === "admin";

  return (
    <>
      <TopBar tenantName={ctx.tenant.name} email={ctx.user.email} />
      <main>
        <h1>Integrations</h1>
        {ok && MESSAGES[ok] && <p className="notice">{MESSAGES[ok]}</p>}
        {error && <p className="error">{MESSAGES[error] ?? "Something went wrong."}</p>}

        <h2>GitHub</h2>
        <div className="card">
          <p className="muted">
            Read-only access to pull requests, reviews, checks and issues: titles, descriptions
            (with secrets and personal data removed) and metadata such as files changed and review
            rounds. Never code contents. Up to 12 months of history is imported.
          </p>
          {list.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Status</th>
                  <th>History import</th>
                </tr>
              </thead>
              <tbody>
                {list.map((c) => {
                  const repos = Object.values(c.backfillState);
                  const prs = repos.reduce((n, r) => n + r.prs, 0);
                  return (
                    <tr key={c.id}>
                      <td>{c.accountLogin ?? c.externalId}</td>
                      <td>
                        <span className="pill">{c.status}</span>
                      </td>
                      <td className="muted">
                        {c.backfillStatus} · {repos.filter((r) => r.done).length}/{repos.length}{" "}
                        repositories · {prs} pull requests
                        {c.backfillError ? ` · ${c.backfillError}` : ""}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {configured && isAdmin && (
            <p>
              <a className="button" href="/integrations/github/install">
                {list.length ? "Connect another GitHub organization" : "Connect GitHub"}
              </a>
            </p>
          )}
          {configured && (
            <p>
              {me?.githubUserId ? (
                <span className="muted">Your GitHub account is linked.</span>
              ) : (
                <a href="/integrations/github/link">Link my GitHub account</a>
              )}{" "}
              <span className="muted">
                Linking credits your pull requests to you; unlinked authors appear as &ldquo;a
                contributor&rdquo;.
              </span>
            </p>
          )}
          {!configured && <p className="muted">{MESSAGES.not_configured}</p>}
        </div>

        <h2>HubSpot</h2>
        <div className="card">
          <p className="muted">
            Read-only. Sequences (names and step counts) with how many enrolled contacts replied or
            booked a meeting; published marketing emails with their delivery, click and unsubscribe
            counts; and deals with their stage and outcome. Contact names, emails, message contents
            and deal amounts are never requested or stored. Connected before November 2026?
            Reconnect once to allow marketing emails and deals.
          </p>
          {hubspot.map((c) => (
            <p key={c.id}>
              {c.accountLogin ?? `Portal ${c.externalId}`} <span className="pill">{c.status}</span>{" "}
              <span className="muted">
                {c.backfillStatus} · {sequences?.n ?? 0} sequences, {sequences?.final ?? 0} with
                results
                {c.backfillError ? ` · ${c.backfillError}` : ""}
              </span>
            </p>
          ))}
          {hubspotConfigFromEnv() ? (
            isAdmin && (
              <p>
                <a className="button" href="/integrations/hubspot/install">
                  {hubspot.length ? "Reconnect HubSpot" : "Connect HubSpot"}
                </a>
              </p>
            )
          ) : (
            <p className="muted">{MESSAGES.hubspot_not_configured}</p>
          )}
        </div>

        <h2>Slack</h2>
        <div className="card">
          <p className="muted">
            Sends direct messages only: channel requests with Approve and Decline buttons, skills
            waiting for review, and changes to skills you follow. It doesn&apos;t read channels or
            messages. People are matched by their work email.
          </p>
          {slack.map((c) => (
            <p key={c.id}>
              {c.accountLogin ?? c.externalId} <span className="pill">{c.status}</span>
            </p>
          ))}
          {slackConfig() ? (
            isAdmin && (
              <p>
                <a className="button" href="/integrations/slack/install">
                  {slack.length ? "Reconnect Slack" : "Connect Slack"}
                </a>
              </p>
            )
          ) : (
            <p className="muted">{MESSAGES.slack_not_configured}</p>
          )}
        </div>
      </main>
    </>
  );
}
