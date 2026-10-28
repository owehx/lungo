export namespace claudeacct {
	
	export class Window {
	    utilization: number;
	    // Go type: time
	    resetsAt: any;
	
	    static createFrom(source: any = {}) {
	        return new Window(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.utilization = source["utilization"];
	        this.resetsAt = this.convertValues(source["resetsAt"], null);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Status {
	    state: string;
	    limitType?: string;
	    // Go type: time
	    resetsAt?: any;
	    windows?: Record<string, Window>;
	    message?: string;
	    // Go type: time
	    checkedAt: any;
	
	    static createFrom(source: any = {}) {
	        return new Status(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.state = source["state"];
	        this.limitType = source["limitType"];
	        this.resetsAt = this.convertValues(source["resetsAt"], null);
	        this.windows = this.convertValues(source["windows"], Window, true);
	        this.message = source["message"];
	        this.checkedAt = this.convertValues(source["checkedAt"], null);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

export namespace collab {
	
	export class SessionInfo {
	    title?: string;
	    where?: string;
	    folder?: string;
	    branch?: string;
	    agent?: string;
	    state?: string;
	    gone?: boolean;
	    mouse?: boolean;
	    alt?: boolean;
	    scrollKey?: boolean;
	
	    static createFrom(source: any = {}) {
	        return new SessionInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.title = source["title"];
	        this.where = source["where"];
	        this.folder = source["folder"];
	        this.branch = source["branch"];
	        this.agent = source["agent"];
	        this.state = source["state"];
	        this.gone = source["gone"];
	        this.mouse = source["mouse"];
	        this.alt = source["alt"];
	        this.scrollKey = source["scrollKey"];
	    }
	}
	export class ShareInfo {
	    id: string;
	    title: string;
	    by: tailnet.Person;
	    role: string;
	    code?: string;
	    info: SessionInfo;
	    cols: number;
	    rows: number;
	
	    static createFrom(source: any = {}) {
	        return new ShareInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.title = source["title"];
	        this.by = this.convertValues(source["by"], tailnet.Person);
	        this.role = source["role"];
	        this.code = source["code"];
	        this.info = this.convertValues(source["info"], SessionInfo);
	        this.cols = source["cols"];
	        this.rows = source["rows"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class JoinInfo {
	    id: string;
	    link: string;
	    share: ShareInfo;
	    term: string;
	    presence: string;
	
	    static createFrom(source: any = {}) {
	        return new JoinInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.link = source["link"];
	        this.share = this.convertValues(source["share"], ShareInfo);
	        this.term = source["term"];
	        this.presence = source["presence"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	

}

export namespace engine {
	
	export class APIKeyView {
	    name: string;
	    provider: string;
	    label: string;
	    icon: string;
	    docs?: string;
	    masked: string;
	    stored: boolean;
	    shell?: string;
	    sync: boolean;
	    machines: string[];
	    canTest: boolean;
	
	    static createFrom(source: any = {}) {
	        return new APIKeyView(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.provider = source["provider"];
	        this.label = source["label"];
	        this.icon = source["icon"];
	        this.docs = source["docs"];
	        this.masked = source["masked"];
	        this.stored = source["stored"];
	        this.shell = source["shell"];
	        this.sync = source["sync"];
	        this.machines = source["machines"];
	        this.canTest = source["canTest"];
	    }
	}
	export class AddSpec {
	    name: string;
	    host: string;
	    user: string;
	    port: number;
	    keyPath: string;
	    alias: string;
	    setup: boolean;
	    tailscale: boolean;
	    takeOver: boolean;
	    tailscaleIp: string;
	
	    static createFrom(source: any = {}) {
	        return new AddSpec(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.host = source["host"];
	        this.user = source["user"];
	        this.port = source["port"];
	        this.keyPath = source["keyPath"];
	        this.alias = source["alias"];
	        this.setup = source["setup"];
	        this.tailscale = source["tailscale"];
	        this.takeOver = source["takeOver"];
	        this.tailscaleIp = source["tailscaleIp"];
	    }
	}
	export class AgentVersion {
	    id: string;
	    version: string;
	
	    static createFrom(source: any = {}) {
	        return new AgentVersion(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.version = source["version"];
	    }
	}
	export class AttachOptions {
	    dir: string;
	    claude: boolean;
	    resume: string;
	    flags: string;
	    prompt: string;
	    run: string;
	    agent: string;
	    seen: number;
	
	    static createFrom(source: any = {}) {
	        return new AttachOptions(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.dir = source["dir"];
	        this.claude = source["claude"];
	        this.resume = source["resume"];
	        this.flags = source["flags"];
	        this.prompt = source["prompt"];
	        this.run = source["run"];
	        this.agent = source["agent"];
	        this.seen = source["seen"];
	    }
	}
	export class Candidate {
	    name: string;
	    source: string;
	    alias?: string;
	    host: string;
	    user?: string;
	    os?: string;
	    online: boolean;
	    tailscaleIp?: string;
	    detail: string;
	    otherSync?: string;
	
	    static createFrom(source: any = {}) {
	        return new Candidate(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.source = source["source"];
	        this.alias = source["alias"];
	        this.host = source["host"];
	        this.user = source["user"];
	        this.os = source["os"];
	        this.online = source["online"];
	        this.tailscaleIp = source["tailscaleIp"];
	        this.detail = source["detail"];
	        this.otherSync = source["otherSync"];
	    }
	}
	export class ClaudeAccountView {
	    account?: model.ClaudeAccount;
	    status: claudeacct.Status;
	    active: boolean;
	    next: boolean;
	    hasToken: boolean;
	    summary: string;
	    plan?: string;
	    person?: string;
	    org?: string;
	    local: boolean;
	    rank: number;
	    reason: string;
	    suggest: boolean;
	
	    static createFrom(source: any = {}) {
	        return new ClaudeAccountView(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.account = this.convertValues(source["account"], model.ClaudeAccount);
	        this.status = this.convertValues(source["status"], claudeacct.Status);
	        this.active = source["active"];
	        this.next = source["next"];
	        this.hasToken = source["hasToken"];
	        this.summary = source["summary"];
	        this.plan = source["plan"];
	        this.person = source["person"];
	        this.org = source["org"];
	        this.local = source["local"];
	        this.rank = source["rank"];
	        this.reason = source["reason"];
	        this.suggest = source["suggest"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Conversation {
	    machine: string;
	    id: string;
	    dir: string;
	    title: string;
	    // Go type: time
	    updated: any;
	    messages?: number;
	    branch?: string;
	    size?: number;
	    auto?: boolean;
	    live?: string;
	    running?: boolean;
	
	    static createFrom(source: any = {}) {
	        return new Conversation(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.machine = source["machine"];
	        this.id = source["id"];
	        this.dir = source["dir"];
	        this.title = source["title"];
	        this.updated = this.convertValues(source["updated"], null);
	        this.messages = source["messages"];
	        this.branch = source["branch"];
	        this.size = source["size"];
	        this.auto = source["auto"];
	        this.live = source["live"];
	        this.running = source["running"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Cost {
	    hourly: number;
	    diskMonthly: number;
	    upHours: number;
	    soFar: number;
	    month: number;
	    basis?: string;
	
	    static createFrom(source: any = {}) {
	        return new Cost(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.hourly = source["hourly"];
	        this.diskMonthly = source["diskMonthly"];
	        this.upHours = source["upHours"];
	        this.soFar = source["soFar"];
	        this.month = source["month"];
	        this.basis = source["basis"];
	    }
	}
	export class Disk {
	    mount: string;
	    total: number;
	    used: number;
	    free: number;
	    pct: number;
	
	    static createFrom(source: any = {}) {
	        return new Disk(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.mount = source["mount"];
	        this.total = source["total"];
	        this.used = source["used"];
	        this.free = source["free"];
	        this.pct = source["pct"];
	    }
	}
	export class GitInfo {
	    repo: boolean;
	    root?: string;
	    branch?: string;
	    detached?: boolean;
	    changed: number;
	    ahead: number;
	    behind: number;
	
	    static createFrom(source: any = {}) {
	        return new GitInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.repo = source["repo"];
	        this.root = source["root"];
	        this.branch = source["branch"];
	        this.detached = source["detached"];
	        this.changed = source["changed"];
	        this.ahead = source["ahead"];
	        this.behind = source["behind"];
	    }
	}
	export class HandoffOptions {
	    to?: string;
	
	    static createFrom(source: any = {}) {
	        return new HandoffOptions(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.to = source["to"];
	    }
	}
	export class IdleState {
	    limit: number;
	    dryRun?: boolean;
	    // Go type: time
	    at: any;
	    active: boolean;
	    reason?: string;
	    // Go type: time
	    since: any;
	
	    static createFrom(source: any = {}) {
	        return new IdleState(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.limit = source["limit"];
	        this.dryRun = source["dryRun"];
	        this.at = this.convertValues(source["at"], null);
	        this.active = source["active"];
	        this.reason = source["reason"];
	        this.since = this.convertValues(source["since"], null);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Health {
	    machine: string;
	    // Go type: time
	    at: any;
	    os: string;
	    cpus: number;
	    load: number[];
	    cpuPct: number;
	    memTotal: number;
	    memUsed: number;
	    memPct: number;
	    pressure?: number;
	    disk: Disk;
	    root?: Disk;
	    uptimeSec: number;
	    warnings: string[];
	    idle?: IdleState;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new Health(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.machine = source["machine"];
	        this.at = this.convertValues(source["at"], null);
	        this.os = source["os"];
	        this.cpus = source["cpus"];
	        this.load = source["load"];
	        this.cpuPct = source["cpuPct"];
	        this.memTotal = source["memTotal"];
	        this.memUsed = source["memUsed"];
	        this.memPct = source["memPct"];
	        this.pressure = source["pressure"];
	        this.disk = this.convertValues(source["disk"], Disk);
	        this.root = this.convertValues(source["root"], Disk);
	        this.uptimeSec = source["uptimeSec"];
	        this.warnings = source["warnings"];
	        this.idle = this.convertValues(source["idle"], IdleState);
	        this.error = source["error"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class IdleInfo {
	    machine: string;
	    offered: boolean;
	    why?: string;
	    minutes: number;
	    dryRun?: boolean;
	    // Go type: time
	    stoppedAt: any;
	    note?: string;
	
	    static createFrom(source: any = {}) {
	        return new IdleInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.machine = source["machine"];
	        this.offered = source["offered"];
	        this.why = source["why"];
	        this.minutes = source["minutes"];
	        this.dryRun = source["dryRun"];
	        this.stoppedAt = this.convertValues(source["stoppedAt"], null);
	        this.note = source["note"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class LocalLogin {
	    email: string;
	    accountId?: string;
	    // Go type: time
	    changedAt?: any;
	
	    static createFrom(source: any = {}) {
	        return new LocalLogin(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.email = source["email"];
	        this.accountId = source["accountId"];
	        this.changedAt = this.convertValues(source["changedAt"], null);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class MovePlan {
	    from: string;
	    to: string;
	    fromDir: string;
	    toDir: string;
	    name: string;
	    exists: boolean;
	    conversations: number;
	    git: boolean;
	    skip: string[];
	
	    static createFrom(source: any = {}) {
	        return new MovePlan(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.from = source["from"];
	        this.to = source["to"];
	        this.fromDir = source["fromDir"];
	        this.toDir = source["toDir"];
	        this.name = source["name"];
	        this.exists = source["exists"];
	        this.conversations = source["conversations"];
	        this.git = source["git"];
	        this.skip = source["skip"];
	    }
	}
	export class ProjectSide {
	    dir: string;
	    path: string;
	    branch: string;
	    head: string;
	    subject: string;
	    // Go type: time
	    commitAt: any;
	    hasUpstream: boolean;
	    ahead: number;
	    behind: number;
	    changed: number;
	    untracked: number;
	
	    static createFrom(source: any = {}) {
	        return new ProjectSide(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.dir = source["dir"];
	        this.path = source["path"];
	        this.branch = source["branch"];
	        this.head = source["head"];
	        this.subject = source["subject"];
	        this.commitAt = this.convertValues(source["commitAt"], null);
	        this.hasUpstream = source["hasUpstream"];
	        this.ahead = source["ahead"];
	        this.behind = source["behind"];
	        this.changed = source["changed"];
	        this.untracked = source["untracked"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ProjectCopy {
	    machine: string;
	    side?: ProjectSide;
	    state: string;
	    text: string;
	    action: string;
	    localCommits: number;
	    remoteCommits: number;
	
	    static createFrom(source: any = {}) {
	        return new ProjectCopy(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.machine = source["machine"];
	        this.side = this.convertValues(source["side"], ProjectSide);
	        this.state = source["state"];
	        this.text = source["text"];
	        this.action = source["action"];
	        this.localCommits = source["localCommits"];
	        this.remoteCommits = source["remoteCommits"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ProjectView {
	    id: string;
	    name: string;
	    folder: string;
	    origin: string;
	    host: string;
	    local?: ProjectSide;
	    copies: ProjectCopy[];
	    saved: boolean;
	
	    static createFrom(source: any = {}) {
	        return new ProjectView(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.folder = source["folder"];
	        this.origin = source["origin"];
	        this.host = source["host"];
	        this.local = this.convertValues(source["local"], ProjectSide);
	        this.copies = this.convertValues(source["copies"], ProjectCopy);
	        this.saved = source["saved"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ProjectList {
	    projects: ProjectView[];
	    machines: string[];
	    errors: Record<string, string>;
	    roots: string[];
	    // Go type: time
	    at: any;
	    stale: boolean;
	
	    static createFrom(source: any = {}) {
	        return new ProjectList(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.projects = this.convertValues(source["projects"], ProjectView);
	        this.machines = source["machines"];
	        this.errors = source["errors"];
	        this.roots = source["roots"];
	        this.at = this.convertValues(source["at"], null);
	        this.stale = source["stale"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	
	export class RemoteFile {
	    path: string;
	    name: string;
	    size: number;
	    // Go type: time
	    mod: any;
	    dir?: boolean;
	
	    static createFrom(source: any = {}) {
	        return new RemoteFile(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.name = source["name"];
	        this.size = source["size"];
	        this.mod = this.convertValues(source["mod"], null);
	        this.dir = source["dir"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Session {
	    machine: string;
	    name: string;
	    // Go type: time
	    created: any;
	    // Go type: time
	    activity: any;
	    attached: number;
	    windows: number;
	    path: string;
	    command: string;
	    claude: boolean;
	    state?: string;
	    // Go type: time
	    stateAt?: any;
	    message?: string;
	    title?: string;
	    sid?: string;
	    flags?: string;
	    branch?: string;
	    // Go type: time
	    claudeSince: any;
	    // Go type: time
	    loginAt: any;
	    oldLogin?: boolean;
	    mouse?: boolean;
	    alt?: boolean;
	    scrollKey?: boolean;
	    agent?: string;
	    stale?: boolean;
	
	    static createFrom(source: any = {}) {
	        return new Session(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.machine = source["machine"];
	        this.name = source["name"];
	        this.created = this.convertValues(source["created"], null);
	        this.activity = this.convertValues(source["activity"], null);
	        this.attached = source["attached"];
	        this.windows = source["windows"];
	        this.path = source["path"];
	        this.command = source["command"];
	        this.claude = source["claude"];
	        this.state = source["state"];
	        this.stateAt = this.convertValues(source["stateAt"], null);
	        this.message = source["message"];
	        this.title = source["title"];
	        this.sid = source["sid"];
	        this.flags = source["flags"];
	        this.branch = source["branch"];
	        this.claudeSince = this.convertValues(source["claudeSince"], null);
	        this.loginAt = this.convertValues(source["loginAt"], null);
	        this.oldLogin = source["oldLogin"];
	        this.mouse = source["mouse"];
	        this.alt = source["alt"];
	        this.scrollKey = source["scrollKey"];
	        this.agent = source["agent"];
	        this.stale = source["stale"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class SessionOptions {
	    name: string;
	    dir: string;
	    claude: boolean;
	    args: string;
	    prompt: string;
	    agent: string;
	
	    static createFrom(source: any = {}) {
	        return new SessionOptions(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.dir = source["dir"];
	        this.claude = source["claude"];
	        this.args = source["args"];
	        this.prompt = source["prompt"];
	        this.agent = source["agent"];
	    }
	}
	export class TailscaleInfo {
	    installed: boolean;
	    connected: boolean;
	    state: string;
	    self: string;
	    ip: string;
	    tailnet: string;
	    hasAuthKey: boolean;
	
	    static createFrom(source: any = {}) {
	        return new TailscaleInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.installed = source["installed"];
	        this.connected = source["connected"];
	        this.state = source["state"];
	        this.self = source["self"];
	        this.ip = source["ip"];
	        this.tailnet = source["tailnet"];
	        this.hasAuthKey = source["hasAuthKey"];
	    }
	}
	export class Tunnel {
	    id: string;
	    machine: string;
	    remotePort: number;
	    localPort: number;
	    url: string;
	    // Go type: time
	    started: any;
	
	    static createFrom(source: any = {}) {
	        return new Tunnel(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.machine = source["machine"];
	        this.remotePort = source["remotePort"];
	        this.localPort = source["localPort"];
	        this.url = source["url"];
	        this.started = this.convertValues(source["started"], null);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

export namespace folders {
	
	export class Options {
	    delete: boolean;
	    excludes: string[];
	    lean: boolean;
	    dryRun: boolean;
	
	    static createFrom(source: any = {}) {
	        return new Options(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.delete = source["delete"];
	        this.excludes = source["excludes"];
	        this.lean = source["lean"];
	        this.dryRun = source["dryRun"];
	    }
	}

}

export namespace main {
	
	export class APIProvider {
	    id: string;
	    label: string;
	    env: string;
	    icon: string;
	    docs: string;
	    canTest: boolean;
	
	    static createFrom(source: any = {}) {
	        return new APIProvider(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.label = source["label"];
	        this.env = source["env"];
	        this.icon = source["icon"];
	        this.docs = source["docs"];
	        this.canTest = source["canTest"];
	    }
	}
	export class ProviderSketch {
	    id: string;
	    label: string;
	
	    static createFrom(source: any = {}) {
	        return new ProviderSketch(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.label = source["label"];
	    }
	}
	export class AppInfo {
	    version: string;
	    platform: string;
	    home: string;
	    localUser: string;
	    configDir: string;
	    terminals: string[];
	    syncItems: syncer.Item[];
	    credentialNames: string[];
	    providers: ProviderSketch[];
	    appIcon: string;
	
	    static createFrom(source: any = {}) {
	        return new AppInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.version = source["version"];
	        this.platform = source["platform"];
	        this.home = source["home"];
	        this.localUser = source["localUser"];
	        this.configDir = source["configDir"];
	        this.terminals = source["terminals"];
	        this.syncItems = this.convertValues(source["syncItems"], syncer.Item);
	        this.credentialNames = source["credentialNames"];
	        this.providers = this.convertValues(source["providers"], ProviderSketch);
	        this.appIcon = source["appIcon"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Catalog {
	    provider: string;
	    regions: model.Region[];
	    sizes: model.Size[];
	    defaultRegion: string;
	    diskPerGB: number;
	
	    static createFrom(source: any = {}) {
	        return new Catalog(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.provider = source["provider"];
	        this.regions = this.convertValues(source["regions"], model.Region);
	        this.sizes = this.convertValues(source["sizes"], model.Size);
	        this.defaultRegion = source["defaultRegion"];
	        this.diskPerGB = source["diskPerGB"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ClaudeStatus {
	    installed: boolean;
	    signedIn: boolean;
	    email: string;
	    org: string;
	    hasToken: boolean;
	
	    static createFrom(source: any = {}) {
	        return new ClaudeStatus(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.installed = source["installed"];
	        this.signedIn = source["signedIn"];
	        this.email = source["email"];
	        this.org = source["org"];
	        this.hasToken = source["hasToken"];
	    }
	}
	export class CollabLocal {
	    watch: string;
	    presence: string;
	
	    static createFrom(source: any = {}) {
	        return new CollabLocal(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.watch = source["watch"];
	        this.presence = source["presence"];
	    }
	}
	export class FilesView {
	    dir: string;
	    files: engine.RemoteFile[];
	
	    static createFrom(source: any = {}) {
	        return new FilesView(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.dir = source["dir"];
	        this.files = this.convertValues(source["files"], engine.RemoteFile);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class FolderActivity {
	    machine: string;
	    dir: string;
	    name: string;
	    // Go type: time
	    updated: any;
	    conversations: number;
	    latest: string;
	    latestTitle: string;
	    branch?: string;
	    live?: string[];
	
	    static createFrom(source: any = {}) {
	        return new FolderActivity(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.machine = source["machine"];
	        this.dir = source["dir"];
	        this.name = source["name"];
	        this.updated = this.convertValues(source["updated"], null);
	        this.conversations = source["conversations"];
	        this.latest = source["latest"];
	        this.latestTitle = source["latestTitle"];
	        this.branch = source["branch"];
	        this.live = source["live"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class HealthView {
	    health: Record<string, engine.Health>;
	    idle: Record<string, engine.IdleInfo>;
	    cost: Record<string, engine.Cost>;
	    choices: number[];
	    // Go type: time
	    at: any;
	
	    static createFrom(source: any = {}) {
	        return new HealthView(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.health = this.convertValues(source["health"], engine.Health, true);
	        this.idle = this.convertValues(source["idle"], engine.IdleInfo, true);
	        this.cost = this.convertValues(source["cost"], engine.Cost, true);
	        this.choices = source["choices"];
	        this.at = this.convertValues(source["at"], null);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class HistoryView {
	    machine: string;
	    conversations: engine.Conversation[];
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new HistoryView(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.machine = source["machine"];
	        this.conversations = this.convertValues(source["conversations"], engine.Conversation);
	        this.error = source["error"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class KeyTest {
	    ok: boolean;
	    detail: string;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new KeyTest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.ok = source["ok"];
	        this.detail = source["detail"];
	        this.error = source["error"];
	    }
	}
	export class LocalTmuxInfo {
	    installed: boolean;
	    path: string;
	    canInstall: boolean;
	    how: string;
	
	    static createFrom(source: any = {}) {
	        return new LocalTmuxInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.installed = source["installed"];
	        this.path = source["path"];
	        this.canInstall = source["canInstall"];
	        this.how = source["how"];
	    }
	}
	export class MachineView {
	    machine?: model.Machine;
	    providerLabel: string;
	    sshShort: string;
	    sshFull: string;
	    address: string;
	    monthly: number;
	    stoppedCost: number;
	    cpus: number;
	    memoryGB: number;
	
	    static createFrom(source: any = {}) {
	        return new MachineView(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.machine = this.convertValues(source["machine"], model.Machine);
	        this.providerLabel = source["providerLabel"];
	        this.sshShort = source["sshShort"];
	        this.sshFull = source["sshFull"];
	        this.address = source["address"];
	        this.monthly = source["monthly"];
	        this.stoppedCost = source["stoppedCost"];
	        this.cpus = source["cpus"];
	        this.memoryGB = source["memoryGB"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class OpInfo {
	    id: string;
	    kind: string;
	    title: string;
	    machine: string;
	    // Go type: time
	    started: any;
	    // Go type: time
	    ended?: any;
	    running: boolean;
	    error?: string;
	    lastLine?: string;
	
	    static createFrom(source: any = {}) {
	        return new OpInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.kind = source["kind"];
	        this.title = source["title"];
	        this.machine = source["machine"];
	        this.started = this.convertValues(source["started"], null);
	        this.ended = this.convertValues(source["ended"], null);
	        this.running = source["running"];
	        this.error = source["error"];
	        this.lastLine = source["lastLine"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class PeekView {
	    file: engine.RemoteFile;
	    local: string;
	    url: string;
	
	    static createFrom(source: any = {}) {
	        return new PeekView(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.file = this.convertValues(source["file"], engine.RemoteFile);
	        this.local = source["local"];
	        this.url = source["url"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class RecentFoldersView {
	    folders: FolderActivity[];
	    errors: Record<string, string>;
	
	    static createFrom(source: any = {}) {
	        return new RecentFoldersView(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.folders = this.convertValues(source["folders"], FolderActivity);
	        this.errors = source["errors"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ScreenView {
	    url: string;
	    user: string;
	    password: string;
	
	    static createFrom(source: any = {}) {
	        return new ScreenView(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.url = source["url"];
	        this.user = source["user"];
	        this.password = source["password"];
	    }
	}
	export class SessionsView {
	    sessions: engine.Session[];
	    errors: Record<string, string>;
	    // Go type: time
	    at: any;
	
	    static createFrom(source: any = {}) {
	        return new SessionsView(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.sessions = this.convertValues(source["sessions"], engine.Session);
	        this.errors = source["errors"];
	        this.at = this.convertValues(source["at"], null);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class SettingsView {
	    defaultProvider: string;
	    remoteUser: string;
	    tailscale: boolean;
	    docker: boolean;
	    autoTmux: boolean;
	    terminal: string;
	    syncInterval: number;
	    syncPaths: string[];
	    skipCredentials: string[];
	    skipMCP: string[];
	
	    static createFrom(source: any = {}) {
	        return new SettingsView(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.defaultProvider = source["defaultProvider"];
	        this.remoteUser = source["remoteUser"];
	        this.tailscale = source["tailscale"];
	        this.docker = source["docker"];
	        this.autoTmux = source["autoTmux"];
	        this.terminal = source["terminal"];
	        this.syncInterval = source["syncInterval"];
	        this.syncPaths = source["syncPaths"];
	        this.skipCredentials = source["skipCredentials"];
	        this.skipMCP = source["skipMCP"];
	    }
	}
	export class ShareView {
	    id: string;
	    machine: string;
	    session: string;
	    title: string;
	    editCode: string;
	    viewCode: string;
	    editLink: string;
	    viewLink: string;
	
	    static createFrom(source: any = {}) {
	        return new ShareView(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.machine = source["machine"];
	        this.session = source["session"];
	        this.title = source["title"];
	        this.editCode = source["editCode"];
	        this.viewCode = source["viewCode"];
	        this.editLink = source["editLink"];
	        this.viewLink = source["viewLink"];
	    }
	}
	export class UpdateInfo {
	    current: string;
	    latest?: string;
	    state: string;
	    progress?: number;
	    notes?: string;
	    error?: string;
	    // Go type: time
	    checkedAt: any;
	    auto: boolean;
	    why?: string;
	
	    static createFrom(source: any = {}) {
	        return new UpdateInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.current = source["current"];
	        this.latest = source["latest"];
	        this.state = source["state"];
	        this.progress = source["progress"];
	        this.notes = source["notes"];
	        this.error = source["error"];
	        this.checkedAt = this.convertValues(source["checkedAt"], null);
	        this.auto = source["auto"];
	        this.why = source["why"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class WindowInfo {
	    id: string;
	    primary: boolean;
	    count: number;
	    headless: boolean;
	    forgotten: string[];
	
	    static createFrom(source: any = {}) {
	        return new WindowInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.primary = source["primary"];
	        this.count = source["count"];
	        this.headless = source["headless"];
	        this.forgotten = source["forgotten"];
	    }
	}

}

export namespace model {
	
	export class Account {
	    id: string;
	    label: string;
	    default?: boolean;
	
	    static createFrom(source: any = {}) {
	        return new Account(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.label = source["label"];
	        this.default = source["default"];
	    }
	}
	export class ClaudeAccount {
	    id: string;
	    label: string;
	    email?: string;
	    disabled?: boolean;
	    // Go type: time
	    addedAt: any;
	    oauthAccount?: Record<string, any>;
	
	    static createFrom(source: any = {}) {
	        return new ClaudeAccount(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.label = source["label"];
	        this.email = source["email"];
	        this.disabled = source["disabled"];
	        this.addedAt = this.convertValues(source["addedAt"], null);
	        this.oauthAccount = source["oauthAccount"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Link {
	    id: string;
	    local: string;
	    machine: string;
	    remote: string;
	    direction: string;
	    excludes?: string[];
	    delete?: boolean;
	    watch?: boolean;
	    // Go type: time
	    lastSync?: any;
	
	    static createFrom(source: any = {}) {
	        return new Link(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.local = source["local"];
	        this.machine = source["machine"];
	        this.remote = source["remote"];
	        this.direction = source["direction"];
	        this.excludes = source["excludes"];
	        this.delete = source["delete"];
	        this.watch = source["watch"];
	        this.lastSync = this.convertValues(source["lastSync"], null);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Machine {
	    name: string;
	    provider: string;
	    account?: string;
	    region?: string;
	    zone?: string;
	    size?: string;
	    diskGB?: number;
	    instanceId?: string;
	    volumeId?: string;
	    status?: string;
	    publicIp?: string;
	    tailscaleIp?: string;
	    tailscaleName?: string;
	    host?: string;
	    port?: number;
	    user: string;
	    keyPath?: string;
	    sshAlias?: string;
	    os?: string;
	    sync: string[];
	    extra?: Record<string, string>;
	    // Go type: time
	    createdAt: any;
	    // Go type: time
	    updatedAt: any;
	
	    static createFrom(source: any = {}) {
	        return new Machine(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.provider = source["provider"];
	        this.account = source["account"];
	        this.region = source["region"];
	        this.zone = source["zone"];
	        this.size = source["size"];
	        this.diskGB = source["diskGB"];
	        this.instanceId = source["instanceId"];
	        this.volumeId = source["volumeId"];
	        this.status = source["status"];
	        this.publicIp = source["publicIp"];
	        this.tailscaleIp = source["tailscaleIp"];
	        this.tailscaleName = source["tailscaleName"];
	        this.host = source["host"];
	        this.port = source["port"];
	        this.user = source["user"];
	        this.keyPath = source["keyPath"];
	        this.sshAlias = source["sshAlias"];
	        this.os = source["os"];
	        this.sync = source["sync"];
	        this.extra = source["extra"];
	        this.createdAt = this.convertValues(source["createdAt"], null);
	        this.updatedAt = this.convertValues(source["updatedAt"], null);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Port {
	    port: number;
	    address: string;
	    process?: string;
	
	    static createFrom(source: any = {}) {
	        return new Port(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.port = source["port"];
	        this.address = source["address"];
	        this.process = source["process"];
	    }
	}
	export class ProviderStatus {
	    id: string;
	    label: string;
	    cli: string;
	    installed: boolean;
	    loggedIn: boolean;
	    identity?: string;
	    accounts?: Account[];
	    hint?: string;
	    install?: string;
	    diskPerGB: number;
	
	    static createFrom(source: any = {}) {
	        return new ProviderStatus(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.label = source["label"];
	        this.cli = source["cli"];
	        this.installed = source["installed"];
	        this.loggedIn = source["loggedIn"];
	        this.identity = source["identity"];
	        this.accounts = this.convertValues(source["accounts"], Account);
	        this.hint = source["hint"];
	        this.install = source["install"];
	        this.diskPerGB = source["diskPerGB"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Region {
	    id: string;
	    label: string;
	    zone?: string;
	
	    static createFrom(source: any = {}) {
	        return new Region(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.label = source["label"];
	        this.zone = source["zone"];
	    }
	}
	export class Size {
	    id: string;
	    label: string;
	    cpus: number;
	    memoryGB: number;
	    monthly: number;
	    note?: string;
	    default?: boolean;
	
	    static createFrom(source: any = {}) {
	        return new Size(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.label = source["label"];
	        this.cpus = source["cpus"];
	        this.memoryGB = source["memoryGB"];
	        this.monthly = source["monthly"];
	        this.note = source["note"];
	        this.default = source["default"];
	    }
	}
	export class Spec {
	    name: string;
	    provider: string;
	    account: string;
	    region: string;
	    zone?: string;
	    size: string;
	    diskGB: number;
	    user: string;
	    tailscale: boolean;
	    docker: boolean;
	
	    static createFrom(source: any = {}) {
	        return new Spec(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.provider = source["provider"];
	        this.account = source["account"];
	        this.region = source["region"];
	        this.zone = source["zone"];
	        this.size = source["size"];
	        this.diskGB = source["diskGB"];
	        this.user = source["user"];
	        this.tailscale = source["tailscale"];
	        this.docker = source["docker"];
	    }
	}

}

export namespace syncer {
	
	export class Credential {
	    path: string;
	    label: string;
	    icon: string;
	    present: boolean;
	    skipped: boolean;
	
	    static createFrom(source: any = {}) {
	        return new Credential(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.label = source["label"];
	        this.icon = source["icon"];
	        this.present = source["present"];
	        this.skipped = source["skipped"];
	    }
	}
	export class Item {
	    id: string;
	    label: string;
	    description: string;
	
	    static createFrom(source: any = {}) {
	        return new Item(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.label = source["label"];
	        this.description = source["description"];
	    }
	}

}

export namespace tailnet {
	
	export class Person {
	    login?: string;
	    name: string;
	    device?: string;
	    avatar?: string;
	
	    static createFrom(source: any = {}) {
	        return new Person(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.login = source["login"];
	        this.name = source["name"];
	        this.device = source["device"];
	        this.avatar = source["avatar"];
	    }
	}

}

export namespace term {
	
	export class Info {
	    id: string;
	    title: string;
	    url: string;
	    // Go type: time
	    started: any;
	    exited: boolean;
	    code: number;
	
	    static createFrom(source: any = {}) {
	        return new Info(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.title = source["title"];
	        this.url = source["url"];
	        this.started = this.convertValues(source["started"], null);
	        this.exited = source["exited"];
	        this.code = source["code"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Probe {
	    cwd: string;
	    command: string;
	    claude: boolean;
	
	    static createFrom(source: any = {}) {
	        return new Probe(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.cwd = source["cwd"];
	        this.command = source["command"];
	        this.claude = source["claude"];
	    }
	}

}

