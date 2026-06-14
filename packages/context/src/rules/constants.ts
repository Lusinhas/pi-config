export const PATH_KEYS = [
  "path",
  "file_path",
  "filePath",
  "absolute_path",
  "absolutePath",
  "file",
  "filename",
  "directory",
  "dir",
] as const;

export const PATH_LIST_KEYS = ["paths", "files"] as const;

export const SEARCH_LOCATIONS =
  ".pi/rules/*.md, .claude/rules/*.md, .cursor/rules/*.mdc, .github/copilot-instructions.md, .github/instructions/*.instructions.md, .windsurf/rules/*.md, .clinerules";

export interface InjectionMessage {
  customType: "rulesinjection";
  content: string;
  display: false;
}
