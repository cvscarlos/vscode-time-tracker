interface MementoLike {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): Thenable<void>;
}

export class MappingStore {
	constructor(private readonly memento: MementoLike) {}

	getProjectId(workspaceKey: string): string | undefined {
		return this.memento.get<string>(`cvsmap:project:${workspaceKey}`);
	}
	setProjectId(workspaceKey: string, id: string): Thenable<void> {
		return this.memento.update(`cvsmap:project:${workspaceKey}`, id);
	}
	getTaskId(workspaceKey: string, branch: string): string | undefined {
		return this.memento.get<string>(`cvsmap:task:${workspaceKey}:${branch}`);
	}
	setTaskId(workspaceKey: string, branch: string, id: string): Thenable<void> {
		return this.memento.update(`cvsmap:task:${workspaceKey}:${branch}`, id);
	}
}
