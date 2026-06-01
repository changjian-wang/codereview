import * as vscode from 'vscode';
import type { PickedModel } from './modelPicker';

/**
 * Holds the model the user picked (or Auto) and resolves an actual chat model
 * on demand. Shared between commands so the choice persists for the session.
 */
export class ModelProvider {
  private picked?: PickedModel;

  set(picked: PickedModel | undefined): void {
    this.picked = picked;
  }

  get label(): string {
    return this.picked?.label ?? 'Auto';
  }

  /** Resolves a usable chat model, honouring an explicit pick or Auto. */
  async resolve(): Promise<vscode.LanguageModelChat | undefined> {
    if (this.picked?.model) {
      return this.picked.model;
    }
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    return models[0];
  }
}
