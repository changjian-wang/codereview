import * as vscode from 'vscode';

/**
 * The model chosen for analysis. `model` is undefined when the user picks
 * "Auto" — in that case callers resolve a model at request time.
 */
export interface PickedModel {
  id: string;
  label: string;
  model?: vscode.LanguageModelChat;
}

/** Lets the user choose among Copilot-authorised models (or Auto). */
export async function pickModel(): Promise<PickedModel | undefined> {
  let models: readonly vscode.LanguageModelChat[] = [];
  try {
    models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
  } catch {
    // selectChatModels can throw before Copilot is ready; treat as empty.
    models = [];
  }

  type Item = vscode.QuickPickItem & { value: PickedModel };
  const items: Item[] = [
    {
      label: 'Auto',
      description: '让 Copilot 自动选择最合适的模型',
      value: { id: 'auto', label: 'Auto' },
    },
    ...models.map((m): Item => ({
      label: m.name,
      description: `${m.vendor} · ${m.family}`,
      detail: `max input ${m.maxInputTokens.toLocaleString()} tokens`,
      value: { id: m.id, label: m.name, model: m },
    })),
  ];

  const choice = await vscode.window.showQuickPick(items, {
    title: 'Code Review · 选择分析模型',
    placeHolder: models.length ? '选择用于代码审查分析的模型' : '未检测到 Copilot 模型，可先选 Auto',
  });
  return choice?.value;
}

/** Resolves an actual chat model, honouring an explicit pick or falling back to Auto. */
export async function resolveModel(picked?: PickedModel): Promise<vscode.LanguageModelChat | undefined> {
  if (picked?.model) {
    return picked.model;
  }
  const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
  return models[0];
}
