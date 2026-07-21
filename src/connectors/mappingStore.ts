interface MementoLike {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): Thenable<void>;
}

export class MappingStore {
	constructor(private readonly memento: MementoLike) {}

	getProjectId(workspaceKey: string): string | undefined {
		return this.memento.get<string>(`ntmap:project:${workspaceKey}`);
	}
	setProjectId(workspaceKey: string, id: string): Thenable<void> {
		return this.memento.update(`ntmap:project:${workspaceKey}`, id);
	}
	getTaskId(workspaceKey: string, branch: string): string | undefined {
		return this.memento.get<string>(`ntmap:task:${workspaceKey}:${branch}`);
	}
	setTaskId(workspaceKey: string, branch: string, id: string): Thenable<void> {
		return this.memento.update(`ntmap:task:${workspaceKey}:${branch}`, id);
	}
}
