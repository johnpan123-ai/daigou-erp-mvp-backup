import json

log_path = r"C:\Users\小河馬\.gemini\antigravity\brain\4b09ad1d-184d-4c5b-9022-a60d7ad0d415\.system_generated\logs\transcript.jsonl"

with open(log_path, 'r', encoding='utf-8') as f:
    for line_num, line in enumerate(f, 1):
        try:
            data = json.loads(line)
            tool_calls = data.get('tool_calls', [])
            has_gen_image = any('generate_image' in tc.get('name', '') for tc in tool_calls)
            if has_gen_image:
                print(f"[Line {line_num}] tool: generate_image")
                print(json.dumps(tool_calls, indent=2, ensure_ascii=False))
                print("-" * 40)
        except Exception as e:
            pass
