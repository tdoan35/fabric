import { Link } from "react-router";
import { useAui, type ToolCallMessagePartProps } from "@assistant-ui/react";
import { ArrowRight, Check, Rocket, Users, UserPlus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Disposition, HandoffPayload, ProposalDecision, SpecialistProposal, TeamProposal } from "@/lib/types";

const DISPOSITION_LABEL: Record<Disposition, string> = {
  handle_directly: "handle directly",
  delegate_agent: "delegate agent",
  delegate_team: "delegate team",
  propose_team: "propose team",
  propose_specialist: "propose specialist",
  clarify: "clarify",
};

export function DispositionChip({ args }: ToolCallMessagePartProps<{ disposition: Disposition; reason: string }>) {
  return (
    <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground" title={args.reason}>
      <span className="size-1.5 rounded-full bg-foreground/60" />
      <span className="rounded-full border px-2 py-0.5 font-mono">{DISPOSITION_LABEL[args.disposition]}</span>
    </div>
  );
}

type Decision = { decision: ProposalDecision };

function Actions({ yes, result, addResult }: { yes: string; result?: Decision; addResult: (r: Decision) => void }) {
  const aui = useAui();
  // Local runtime doesn't auto-resume after a human tool result, so start the next turn ourselves.
  const decide = (r: Decision) => {
    addResult(r);
    const msgs = aui.thread().getState().messages;
    aui.thread().startRun({ parentId: msgs[msgs.length - 1].id });
  };
  if (result?.decision === "approved") return <Badge className="bg-ok-soft text-ok hover:bg-ok-soft"><Check className="size-3" /> Approved</Badge>;
  if (result?.decision === "declined") return <Badge variant="secondary">Declined</Badge>;
  return (
    <div className="flex items-center gap-2">
      <Button size="sm" onClick={() => decide({ decision: "approved" })}>{yes}</Button>
      <Button size="sm" variant="outline" onClick={() => decide({ decision: "declined" })}>No</Button>
      <Button size="sm" variant="ghost" onClick={() => decide({ decision: "discuss" })}>Chat about this</Button>
    </div>
  );
}

export function TeamProposalCard({ args, result, addResult }: ToolCallMessagePartProps<TeamProposal, Decision>) {
  return (
    <div className="my-3 rounded-xl border bg-card p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium"><Users className="size-4" />{args.name}<span className="text-xs font-normal text-muted-foreground">proposed team</span></div>
        {result?.decision === "approved" ? <Badge className="bg-ok-soft text-ok hover:bg-ok-soft">Approved</Badge> : <Badge className="bg-warn-soft text-warn hover:bg-warn-soft">Needs approval</Badge>}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {args.roster.map((r) => (
          <div key={r.agentId} className="flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs">
            <span className="font-medium">{r.name}</span>
            <span className={r.status === "new" ? "text-run" : "text-muted-foreground"}>{r.status}</span>
          </div>
        ))}
      </div>
      {!result && <div className="mt-3"><Actions yes="Build team" result={result} addResult={addResult} /></div>}
      {result && result.decision !== "approved" && <div className="mt-3 text-xs text-muted-foreground">{result.decision === "discuss" ? "Discussing — proposal still pending." : "Declined."}</div>}
    </div>
  );
}

export function SpecialistProposalCard({ args, result, addResult }: ToolCallMessagePartProps<SpecialistProposal, Decision>) {
  return (
    <div className="my-3 rounded-xl border bg-card p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium"><UserPlus className="size-4" />{args.name}</div>
        {result?.decision === "approved" ? <Badge className="bg-ok-soft text-ok hover:bg-ok-soft">Approved</Badge> : <Badge className="bg-warn-soft text-warn hover:bg-warn-soft">New specialist</Badge>}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{args.purpose}</p>
      <dl className="mt-3 grid grid-cols-[80px_1fr] gap-x-3 gap-y-2 text-xs">
        {args.rows.map((r) => (
          <div key={r.label} className="contents">
            <dt className="text-muted-foreground">{r.label}</dt>
            <dd><div>{r.value}</div><div className="text-muted-foreground">{r.why}</div></dd>
          </div>
        ))}
      </dl>
      {!result && <div className="mt-4"><Actions yes="Yes, create Validator" result={result} addResult={addResult} /></div>}
      {result && result.decision !== "approved" && <div className="mt-3 text-xs text-muted-foreground">{result.decision === "discuss" ? "Discussing — proposal still pending." : "Declined."}</div>}
    </div>
  );
}

export function HandoffCard({ args }: ToolCallMessagePartProps<HandoffPayload>) {
  return (
    <div className="my-3 rounded-xl border bg-card p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium"><Rocket className="size-4" />Task handed off to {args.teamName}</div>
        <Badge className="bg-run-soft text-run hover:bg-run-soft">Running</Badge>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{args.summary}</p>
      <div className="mt-3 grid grid-cols-4 gap-2">
        {args.members.map((m) => (
          <div key={m.name} className="rounded-lg bg-muted px-2.5 py-2 text-xs">
            <div className="font-medium">{m.name}</div>
            <div className="flex items-center gap-1 text-muted-foreground"><span className="size-1.5 rounded-full bg-run" />{m.state}</div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex gap-2">
        <Button size="sm" asChild><Link to={`/runs/${args.runId}?live=1`}>View loop <ArrowRight /></Link></Button>
      </div>
    </div>
  );
}
