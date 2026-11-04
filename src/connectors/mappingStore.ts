interface MementoLike {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): PromiseLike<void>;
}

export class MappingStore {
	constructor(private readonly memento: MementoLike) {}

	getProjectId(workspaceKey: string): string | undefined {
		return this.memento.get<string>(`ntmap:project:${workspaceKey}`);
	}
	setProjectId(workspaceKey: string, id: string): PromiseLike<void> {
		return this.memento.update(`ntmap:project:${workspaceKey}`, id);
	}
	clearProjectId(workspaceKey: string): PromiseLike<void> {
		return this.memento.update(`ntmap:project:${workspaceKey}`, undefined);
	}
	getTaskId(workspaceKey: string, branch: string): string | undefined {
		return this.memento.get<string>(`ntmap:task:${workspaceKey}:${branch}`);
	}
	setTaskId(workspaceKey: string, branch: string, id: string): PromiseLike<void> {
		return this.memento.update(`ntmap:task:${workspaceKey}:${branch}`, id);
	}
	clearTaskId(workspaceKey: string, branch: string): PromiseLike<void> {
		return this.memento.update(`ntmap:task:${workspaceKey}:${branch}`, undefined);
	}
}
