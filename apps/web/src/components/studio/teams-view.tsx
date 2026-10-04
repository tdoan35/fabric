import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { ArrowRight, ChevronDown, CornerDownLeft, Crown, Folder, FolderOpen, ListChecks, Play, Plus, Sparkles, Users, Workflow, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Portrait, ring } from "@/components/chat/assistant-hero";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { profileById } from "@/lib/mock/studio";
import { communityTeams, organizations, studioTeams, type Organization, type StudioTeam } from "@/lib/mock/teams";
import { TeamLoops } from "@/components/work/team-loops";
import { lastLoopAt, teamLoopCount } from "@/lib/work";
import { EASE, Group, SectionHead, panel, pill, surface } from "./studio-ui";

type Section = "mine" | "community";
export type TeamsView = "teams" | "orgs";
const cardId = (id: string) => `team-card-${id}`;
const formatInstalls = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n));

/** The Teams and Organizations panes of the studio page. The page owns the header and the view switch. */
export function TeamsStudio({ view, onViewChange }: { view: TeamsView; onViewChange: (v: TeamsView) => void }) {
  const [mine, setMine] = useState(studioTeams);
  const [community, setCommunity] = useState(communityTeams);
  const [sel, setSel] = useState<{ id: string; from: Section } | null>(null);
  const [orgs, setOrgs] = useState(organizations);

  const add = (id: string) => {
    const t = community.find((c) => c.id === id);
    if (!t) return;
    setCommunity((c) => c.filter((x) => x.id !== id));
    setMine((m) => [...m, { ...t, origin: `From ${t.author}` }]);
    setSel(null);
  };

  /** Adding a community team to an org also adds it to your teams. */
  const addToOrg = (orgId: string, teamId: string) => {
    if (community.some((c) => c.id === teamId)) add(teamId);
    const key = `${teamId}-${Date.now().toString(36)}`;
    setOrgs((os) => os.map((o) => (o.id === orgId ? { ...o, slots: [...o.slots, { key, teamId }] } : o)));
  };
  const removeFromOrg = (orgId: string, key: string) =>
    setOrgs((os) => os.map((o) => (o.id === orgId ? { ...o, slots: o.slots.filter((x) => x.key !== key) } : o)));

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div key={view} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.2 }}>
        {view === "teams"
          ? <TeamsView mine={mine} community={community} sel={sel} onSelect={setSel} onAdd={add} />
          : (
            <OrgView
              orgs={orgs} teams={mine} community={community}
              onOpen={(id) => { setSel({ id, from: "mine" }); onViewChange("teams"); }}
              onAddTeam={addToOrg} onRemoveTeam={removeFromOrg}
            />
          )}
      </motion.div>
    </AnimatePresence>
  );
}

/**
 * Your teams and community teams. Opening a card expands it in place
 * (Members · Workflow · Runs) and fades the other section out.
 */
function TeamsView({ mine, community, sel, onSelect, onAdd }: {
  mine: StudioTeam[]; community: StudioTeam[]; sel: { id: string; from: Section } | null;
  onSelect: (s: { id: string; from: Section } | null) => void; onAdd: (id: string) => void;
}) {
  const close = useCallback(() => onSelect(null), [onSelect]);
  const selected = sel && (sel.from === "mine" ? mine : community).find((t) => t.id === sel.id);

  useEffect(() => {
    if (!sel) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sel, close]);

  return (
    <LayoutGroup>
      <div className="flex flex-col gap-10">
        <AnimatePresence initial={false} mode="popLayout">
          {sel?.from !== "community" && (
            <motion.section key="mine" layout="position" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={EASE}>
              <SectionHead title="Your teams" count={mine.length} hint="Dana proposes teams in chat; you approve them. Agents are reused across teams, never copied." />
              {selected && sel?.from === "mine"
                ? <ExpandedTeam team={selected} teams={mine} onClose={close} />
                : (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {mine.map((t) => <TeamCard key={t.id} team={t} onOpen={() => onSelect({ id: t.id, from: "mine" })} />)}
                  </div>
                )}
            </motion.section>
          )}
          {sel?.from !== "mine" && (
            <motion.section key="community" layout="position" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={EASE}>
              <SectionHead title="Community teams" count={community.length} hint="Teams shared by others. Adding one brings its members along, with empty memories." />
              {selected && sel?.from === "community"
                ? <ExpandedTeam team={selected} teams={mine} onClose={close} onAdd={() => onAdd(selected.id)} />
                : community.length > 0
                  ? (
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      {community.map((t) => <CommunityTeamCard key={t.id} team={t} onOpen={() => onSelect({ id: t.id, from: "community" })} onAdd={() => onAdd(t.id)} />)}
                    </div>
                  )
                  : <p className="rounded-2xl border border-dashed border-foreground/15 px-4 py-8 text-center text-sm text-muted-foreground">You&apos;ve added every community team.</p>}
            </motion.section>
          )}
        </AnimatePresence>
      </div>
    </LayoutGroup>
  );
}

function OrgView({ orgs, teams, community, onOpen, onAddTeam, onRemoveTeam }: {
  orgs: Organization[]; teams: StudioTeam[]; community: StudioTeam[];
  onOpen: (teamId: string) => void; onAddTeam: (orgId: string, teamId: string) => void; onRemoveTeam: (orgId: string, key: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);

  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setEditing(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing]);

  return (
    <section>
      <SectionHead title="Your organizations" count={orgs.length} hint="Dana sits at the top. Teams hang off her by their leads. Click an org's tab to add or remove teams." />
      <div className="flex flex-col gap-8">
        {orgs.map((o) => (
          <OrgFolder
            key={o.id} org={o} teams={teams} community={community}
            editing={editing === o.id}
            onToggle={() => setEditing((e) => (e === o.id ? null : o.id))}
            onOpen={onOpen}
            onAddTeam={(teamId) => onAddTeam(o.id, teamId)}
            onRemoveTeam={(key) => onRemoveTeam(o.id, key)}
          />
        ))}
      </div>
    </section>
  );
}

function StatusPill({ team }: { team: StudioTeam }) {
  const active = team.status === "active";
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium", active ? "bg-ok-soft text-ok" : "bg-foreground/5 text-muted-foreground")}>
      <span className={cn("size-1.5 rounded-full", active ? "bg-ok" : "bg-muted-foreground/60")} />
      {active ? "Active" : "Idle"}
    </span>
  );
}

function AvatarStack({ team, size = "size-10" }: { team: StudioTeam; size?: string }) {
  return (
    <div className="flex -space-x-2.5">
      {team.members.map((m) => {
        const { agent } = profileById(m.agentId);
        return (
          <div key={m.agentId} title={`${agent.name} · ${agent.role}${m.lead ? " · Lead" : ""}`} className="relative rounded-full ring-2 ring-background/80">
            <Portrait agent={agent} className={cn(size, "border border-foreground/20")} />
            {m.lead && <Crown className="absolute -left-1 -top-1 z-10 size-4 rounded-full bg-background p-0.5 text-warn shadow-sm ring-1 ring-foreground/10" />}
          </div>
        );
      })}
    </div>
  );
}

function TeamCard({ team, onOpen }: { team: StudioTeam; onOpen: () => void }) {
  const lead = profileById(team.members.find((m) => m.lead)!.agentId).agent;
  const last = lastLoopAt(team.id);
  return (
    <motion.button
      type="button"
      layoutId={cardId(team.id)}
      transition={EASE}
      onClick={onOpen}
      style={{ borderRadius: 16 }}
      className={cn("group flex flex-col items-start gap-3 p-5 text-left outline-none transition-colors hover:border-foreground/20 hover:bg-background/80 focus-visible:ring-2 focus-visible:ring-ring", surface)}
    >
      <div className="flex w-full items-center gap-2">
        <span className="text-base font-semibold">{team.name}</span>
        <StatusPill team={team} />
        <span className={cn(pill, "ml-auto")}>{team.origin}</span>
      </div>
      <p className="text-sm text-foreground/70">{team.tagline}</p>
      <AvatarStack team={team} />
      <p className="text-xs text-muted-foreground">
        Led by {lead.name} · {team.members.length} members · {last ? `last loop ${last}` : "no loops yet"}
      </p>
    </motion.button>
  );
}

function CommunityTeamCard({ team, onOpen, onAdd }: { team: StudioTeam; onOpen: () => void; onAdd: () => void }) {
  return (
    <motion.div layoutId={cardId(team.id)} transition={EASE} style={{ borderRadius: 16 }} className={cn("group relative transition-colors hover:border-foreground/20 hover:bg-background/80", surface)}>
      <button type="button" onClick={onOpen} className="flex w-full flex-col items-start gap-2.5 rounded-2xl p-4 pr-11 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{team.name}</div>
          <p className="truncate text-xs text-foreground/70">{team.tagline}</p>
        </div>
        <AvatarStack team={team} size="size-8" />
        <p className="text-[11px] text-muted-foreground">{team.author} · {formatInstalls(team.installs ?? 0)} added · {team.members.length} members</p>
      </button>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button type="button" size="icon" variant="ghost" onClick={onAdd} aria-label={`Add ${team.name} to your teams`} className="absolute right-2 top-2 size-7 rounded-full text-muted-foreground hover:bg-foreground/5 hover:text-foreground">
            <Plus />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Add to your teams</TooltipContent>
      </Tooltip>
    </motion.div>
  );
}

/* ── Expanded team ────────────────────────────────────────────────── */

function ExpandedTeam({ team, teams, onClose, onAdd }: { team: StudioTeam; teams: StudioTeam[]; onClose: () => void; onAdd?: () => void }) {
  return (
    <motion.div layoutId={cardId(team.id)} transition={EASE} style={{ borderRadius: 16 }} className={cn("overflow-hidden", surface, "bg-background/60")}>
      <div className="flex items-start gap-5 p-6 pb-5">
        <motion.div className="min-w-0 flex-1" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { delay: 0.12, duration: 0.3 } }}>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-semibold tracking-tight">{team.name}</h2>
            <StatusPill team={team} />
            {team.author ? <span className="text-xs text-muted-foreground">by {team.author}</span> : <span className={pill}>{team.origin}</span>}
          </div>
          <p className="mt-1.5 max-w-[620px] text-sm leading-relaxed text-muted-foreground">{team.purpose}</p>
        </motion.div>
        <div className="flex shrink-0 items-center gap-1">
          {onAdd && <Button size="sm" className="h-8" onClick={onAdd}><Plus />Add to your teams</Button>}
          <Button size="icon" variant="ghost" className="size-8 rounded-full" onClick={onClose} aria-label="Close team"><X /></Button>
        </div>
      </div>

      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0, transition: { delay: 0.18, duration: 0.35 } }}>
        <Tabs defaultValue="members" className="gap-4 px-6 pb-6">
          <TabsList className="bg-foreground/5">
            <TabsTrigger value="members"><Users />Members<span className="tabular-nums text-muted-foreground">{team.members.length}</span></TabsTrigger>
            <TabsTrigger value="workflow"><Workflow />Workflow</TabsTrigger>
            <TabsTrigger value="runs"><Play />Loops<span className="tabular-nums text-muted-foreground">{teamLoopCount(team.id)}</span></TabsTrigger>
          </TabsList>
          <TabsContent value="members"><MembersTab team={team} teams={teams} /></TabsContent>
          <TabsContent value="workflow"><WorkflowTab team={team} /></TabsContent>
          <TabsContent value="runs"><TeamLoops team={team} /></TabsContent>
        </Tabs>
      </motion.div>
    </motion.div>
  );
}

function MembersTab({ team, teams }: { team: StudioTeam; teams: StudioTeam[] }) {
  return (
    <ul className={cn(panel, "divide-y divide-foreground/10")}>
      {team.members.map((m) => {
        const { agent, origin } = profileById(m.agentId);
        const also = teams.filter((t) => t.id !== team.id && t.members.some((x) => x.agentId === m.agentId));
        return (
          <li key={m.agentId}>
            <Link to={`/agents?agent=${agent.id}`} className="group flex items-center gap-3 px-3 py-2.5 transition-colors first:rounded-t-xl last:rounded-b-xl hover:bg-foreground/5">
              <Portrait agent={agent} className="size-10 border-2 border-foreground/25" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
                  <span className="font-medium">{agent.name}</span>
                  <span className="text-muted-foreground">{agent.role}</span>
                  {m.lead && <span className="inline-flex items-center gap-1 rounded-full bg-warn-soft px-1.5 py-px text-[10px] font-medium text-warn"><Crown className="size-2.5" />Lead</span>}
                  {also.map((t) => <span key={t.id} className={pill}>Also on {t.name}</span>)}
                  {origin && <span className={pill}>{origin}</span>}
                </div>
                <p className="truncate text-xs text-muted-foreground">{m.duty}</p>
              </div>
              <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">Profile <ArrowRight className="size-3" /></span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function WorkflowTab({ team }: { team: StudioTeam }) {
  const lead = profileById(team.members.find((m) => m.lead)!.agentId).agent;
  return (
    <div className="grid gap-5 md:grid-cols-[1fr_260px]">
      <Group icon={Workflow} title="Steps">
        <ol className={cn(panel, "relative px-4 py-3")}>
          {team.workflow.map((st, i) => {
            const parallel = st.agentIds.length > 1;
            const last = i === team.workflow.length - 1;
            return (
              <li key={st.label} className="relative flex gap-3 pb-4 last:pb-0">
                {!last && <span className="absolute left-[11px] top-7 bottom-1 w-px bg-foreground/15" />}
                <span className="grid size-6 shrink-0 place-items-center rounded-full bg-foreground/5 text-[11px] font-medium tabular-nums ring-1 ring-foreground/10">{i + 1}</span>
                <div className="min-w-0 flex-1 pt-0.5">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {st.label}
                    {parallel && <span className={pill}>parallel</span>}
                  </div>
                  <p className="text-xs text-muted-foreground">{st.note}</p>
                  {st.gate && (
                    <p className="mt-1.5 inline-flex items-center gap-1.5 rounded-md bg-warn-soft px-2 py-1 text-[11px] text-warn">
                      <CornerDownLeft className="size-3" />Changes requested → back to {lead.name} · rework budget {team.reworkBudget}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 -space-x-2 pt-0.5">
                  {st.agentIds.map((id) => {
                    const { agent } = profileById(id);
                    return <span key={id} title={agent.name} className="inline-flex rounded-full ring-2 ring-background/80"><Portrait agent={agent} className="size-7 border border-foreground/20" /></span>;
                  })}
                </div>
              </li>
            );
          })}
        </ol>
      </Group>
      <Group icon={ListChecks} title="Done when" count={team.criteria.length}>
        <ul className={cn(panel, "space-y-2 px-3 py-2.5 text-xs")}>
          {team.criteria.map((c) => (
            <li key={c} className="flex gap-2"><span className="mt-1.5 size-1 shrink-0 rounded-full bg-muted-foreground" />{c}</li>
          ))}
        </ul>
      </Group>
    </div>
  );
}

/* ── Organization chart (folder) ─────────────────────────────────── */


/** An org drawn as a file folder: the name on the tab, an org chart inside. Clicking the tab opens it for editing. */
function OrgFolder({ org, teams, community, editing, onToggle, onOpen, onAddTeam, onRemoveTeam }: {
  org: Organization; teams: StudioTeam[]; community: StudioTeam[]; editing: boolean;
  onToggle: () => void; onOpen: (teamId: string) => void; onAddTeam: (teamId: string) => void; onRemoveTeam: (key: string) => void;
}) {
  // Each slot is one copy of a team; the nth copy of a team gets a "copy n" tag.
  const seen = new Map<string, number>();
  const orgTeams = org.slots.flatMap(({ key, teamId }) => {
    const team = teams.find((t) => t.id === teamId);
    if (!team) return [];
    const copy = (seen.get(teamId) ?? 0) + 1;
    seen.set(teamId, copy);
    return [{ key, team, copy }];
  });
  const head = profileById(org.headId).agent;
  const folderBg = "bg-background/55 backdrop-blur-md";
  // An agent on more than one team in this org is drawn under each, tagged "shared".
  const distinct = [...new Map(orgTeams.map(({ team }) => [team.id, team])).values()];
  const sharedIds = new Set(distinct.flatMap((t) => t.members.map((m) => m.agentId)).filter((id, i, all) => all.indexOf(id) !== i));

  return (
    <motion.div layout transition={EASE} className="relative">
      {/* Tab: shares the body's fill and sits over its top border so the two read as one shape. */}
      <motion.button
        layout="position"
        type="button"
        onClick={onToggle}
        aria-expanded={editing}
        className={cn(
          "group relative z-10 -mb-px inline-flex h-9 items-center gap-2 rounded-t-xl border border-b-0 border-foreground/10 pl-3.5 pr-3 text-sm outline-none transition-colors hover:bg-background/80 focus-visible:ring-2 focus-visible:ring-ring",
          folderBg, editing && "bg-background/80",
        )}
      >
        {editing ? <FolderOpen className="size-4 text-foreground" /> : <Folder className="size-4 text-muted-foreground" />}
        <span className="font-semibold">{org.name}</span>
        <span className="text-xs tabular-nums text-muted-foreground">{orgTeams.length} {orgTeams.length === 1 ? "team" : "teams"}</span>
        <ChevronDown className={cn("size-3.5 text-muted-foreground transition-transform duration-300", editing && "rotate-180")} />
      </motion.button>

      <motion.div layout transition={EASE} style={{ borderRadius: 16, borderTopLeftRadius: 0 }} className={cn("border border-foreground/10 px-6 pb-6 pt-7 shadow-sm transition-colors", folderBg, editing && "border-foreground/20")}>
        {/* Head */}
        <motion.div layout="position" transition={EASE} className="flex flex-col items-center">
          <OrgNode agent={head} size="size-16" subtitle={head.role} emphasis />
          {(orgTeams.length > 0 || editing) && <span className={cn("h-6 w-px", line)} />}
        </motion.div>

        {/* Branch: Dana → each team, by its lead. Each column draws its half of the rail, like the member rows. */}
        <div className="-mx-6 overflow-x-auto px-6 pb-1 [scrollbar-width:none] hover:[scrollbar-width:thin]">
          <ul className="mx-auto flex w-max">
            <AnimatePresence initial={false} mode="popLayout">
              {orgTeams.map(({ key, team: t, copy }) => (
                <motion.li
                  key={key}
                  layout
                  transition={EASE}
                  initial={{ opacity: 0, scale: 0.96 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.96 }}
                  className={cn(branch, "px-1.5 pt-6")}
                >
                  <span className={cn("absolute left-1/2 top-0 h-6 w-px", line)} />
                  <OrgTeamBox team={t} copy={copy} sharedIds={sharedIds} onOpen={() => onOpen(t.id)} onRemove={editing ? () => onRemoveTeam(key) : undefined} />
                </motion.li>
              ))}
              {editing && (
                <motion.li
                  key="add-slot"
                  layout
                  transition={EASE}
                  initial={{ opacity: 0, scale: 0.96 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.96 }}
                  className={cn(branch, "px-1.5 pt-6")}
                >
                  <span className="absolute left-1/2 top-0 h-6 border-l border-dashed border-foreground/25" />
                  <div className="grid h-full min-h-[236px] w-[200px] place-items-center rounded-xl border-2 border-dashed border-foreground/15 text-center text-xs text-muted-foreground">
                    <div className="flex flex-col items-center gap-2">
                      <span className="grid size-9 place-items-center rounded-full bg-foreground/5"><Plus className="size-4" /></span>
                      Pick a team below
                    </div>
                  </div>
                </motion.li>
              )}
            </AnimatePresence>
          </ul>
        </div>

        <AnimatePresence initial={false}>
          {editing && (
            <motion.div
              key="add"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={EASE}
              className="overflow-hidden"
            >
              <div className="mt-6 border-t border-foreground/10 pt-5">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-sm font-semibold">Add teams to {org.name}</h3>
                  <Button size="sm" variant="ghost" className="h-7" onClick={onToggle}>Done</Button>
                </div>
                <div className="grid gap-5 md:grid-cols-2">
                  <Group icon={Users} title="Your teams" count={teams.length}>
                    <ul className="space-y-2">
                      {teams.map((t) => <AddTeamRow key={t.id} team={t} inOrg={seen.get(t.id) ?? 0} onAdd={() => onAddTeam(t.id)} />)}
                    </ul>
                  </Group>
                  <Group icon={Sparkles} title="Community teams" count={community.length}>
                    {community.length > 0
                      ? <ul className="space-y-2">{community.map((t) => <AddTeamRow key={t.id} team={t} onAdd={() => onAddTeam(t.id)} />)}</ul>
                      : <p className="rounded-xl border border-dashed border-foreground/15 px-3 py-4 text-center text-xs text-muted-foreground">No community teams left to add.</p>}
                  </Group>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </motion.div>
  );
}

const line = "bg-foreground/20";
/** Org-chart rail: each child draws its half on either side; the ends trim theirs. */
const branch = cn(
  "relative flex flex-col items-center",
  "before:absolute before:left-0 before:top-0 before:h-px before:w-1/2 before:bg-foreground/20 after:absolute after:right-0 after:top-0 after:h-px after:w-1/2 after:bg-foreground/20",
  "first:before:hidden last:after:hidden",
);

function AddTeamRow({ team, inOrg = 0, onAdd }: { team: StudioTeam; inOrg?: number; onAdd: () => void }) {
  return (
    <li className={cn(panel, "flex items-center gap-3 px-3 py-2")}>
      <AvatarStack team={team} size="size-7" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{team.name}</div>
        <div className="truncate text-xs text-muted-foreground">
          {team.author ? `by ${team.author} · ` : ""}{team.members.length} members{inOrg > 0 && ` · ${inOrg === 1 ? "in this org" : `${inOrg} copies in this org`}`}
        </div>
      </div>
      <Button size="sm" variant="outline" className="h-7 bg-background/60" onClick={onAdd}><Plus />{inOrg > 0 ? "Add copy" : "Add"}</Button>
    </li>
  );
}

function OrgTeamBox({ team, copy, sharedIds, onOpen, onRemove }: { team: StudioTeam; copy: number; sharedIds: Set<string>; onOpen: () => void; onRemove?: () => void }) {
  const lead = profileById(team.members.find((m) => m.lead)!.agentId).agent;
  const rest = team.members.filter((m) => !m.lead);
  return (
    <div className="group/box relative">
      <button
        type="button"
        onClick={onOpen}
        className={cn(panel, "flex min-h-[236px] min-w-[200px] flex-col items-center px-3 pb-4 pt-3 outline-none transition-colors hover:border-foreground/20 hover:bg-background/80 focus-visible:ring-2 focus-visible:ring-ring", team.status === "idle" && "border-dashed")}
      >
        <div className="mb-3 flex h-5 items-center gap-2 text-sm font-medium">
          {team.name}
          {copy > 1 && <span className={pill}>copy {copy}</span>}
          <StatusPill team={team} />
        </div>
        <OrgNode agent={lead} size="size-14" subtitle={`${lead.role} · Lead`} lead />
        {rest.length > 0 && (
          <>
            <span className={cn("h-4 w-px", line)} />
            <ul className="flex">
              {rest.map((m) => {
                const { agent } = profileById(m.agentId);
                return (
                  <li key={m.agentId} className={cn(branch, "px-0.5 pt-4")}>
                    <span className={cn("absolute left-1/2 top-0 h-4 w-px", line)} />
                    <OrgNode agent={agent} size="size-10" subtitle={agent.role} compact shared={sharedIds.has(m.agentId)} />
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </button>
      {onRemove && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onRemove}
              aria-label={`Remove ${team.name}${copy > 1 ? ` (copy ${copy})` : ""} from this organization`}
              className="absolute -right-2 -top-2 grid size-6 place-items-center rounded-full bg-background text-muted-foreground shadow-sm ring-1 ring-foreground/15 transition-colors hover:text-destructive"
            >
              <X className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Remove from this org (the team itself is kept)</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

function OrgNode({ agent, size, subtitle, emphasis, lead, compact, shared }: {
  agent: ReturnType<typeof profileById>["agent"]; size: string; subtitle: string; emphasis?: boolean; lead?: boolean; compact?: boolean; shared?: boolean;
}) {
  return (
    <div className={cn("flex flex-col items-center text-center", compact ? "w-[72px]" : "w-36")}>
      <div className="relative">
        <Portrait agent={agent} className={cn(size, emphasis || lead ? ring : "border-2 border-foreground/25")} />
        {lead && <Crown className="absolute -left-1 -top-1 size-4 rounded-full bg-background p-0.5 text-warn shadow-sm ring-1 ring-foreground/10" />}
      </div>
      <span className={cn("mt-1.5 font-medium", compact ? "text-xs" : "text-sm")}>{agent.name}</span>
      <span className={cn("max-w-full truncate text-muted-foreground", compact ? "text-[10px]" : "text-xs")}>{subtitle}</span>
      {shared && <span className={cn(pill, "mt-1")}>shared</span>}
    </div>
  );
}
