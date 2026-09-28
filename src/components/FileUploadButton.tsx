import { useRef } from 'react';
import { Upload } from 'lucide-react';

interface FileUploadButtonProps {
  accept: string;
  inputLabel: string;
  label: string;
  selectedFileName?: string;
  disabled?: boolean;
  variant?: 'primary' | 'outline';
  onFile: (file: File) => void;
}

/** ERP import pattern: an accessible button opens a real, visually hidden file input. */
export function FileUploadButton({ accept, inputLabel, label, selectedFileName,
  disabled = false, variant = 'primary', onFile }: FileUploadButtonProps) {
  const input = useRef<HTMLInputElement>(null);
  return <div className="file-upload-control">
    <input ref={input} type="file" accept={accept} aria-label={inputLabel}
      style={{ display: 'none' }} disabled={disabled}
      onChange={event => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = '';
        if (file) onFile(file);
      }} />
    <button type="button" className={`btn btn-md ${variant === 'primary' ? 'btn-primary' : 'btn-outline'}`}
      disabled={disabled} onClick={() => input.current?.click()}>
      <Upload size={16} aria-hidden="true" /> {selectedFileName ? '重新選擇檔案' : label}
    </button>
    {selectedFileName && <span className="file-upload-selection" role="status">
      <span>{selectedFileName}</span><span className="badge badge-success">✓ 已選擇</span>
    </span>}
  </div>;
}
