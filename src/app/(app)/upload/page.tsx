"use client";

import { useState, useCallback } from "react";
import { useDropzone } from "react-dropzone";
import { useAuth } from "@/lib/auth/auth-context";
import { createBrowserClient } from "@/lib/supabase/client";
import { ConsentGate } from "@/lib/consent/consent-gate";

function UploadForm() {
  const { user } = useAuth();
  const [docType, setDocType] = useState<"eob" | "itemized_bill">("eob");
  const [uploading, setUploading] = useState(false);
  const [uploaded, setUploaded] = useState(false);
  const [error, setError] = useState("");
  const [fileName, setFileName] = useState("");

  const onDrop = useCallback(
    async (acceptedFiles: File[]) => {
      if (!user || acceptedFiles.length === 0) return;

      const file = acceptedFiles[0];
      if (file.type !== "application/pdf") {
        setError("Only PDF files are accepted.");
        return;
      }
      if (file.size > 20 * 1024 * 1024) {
        setError("File must be under 20MB.");
        return;
      }

      setUploading(true);
      setError("");
      setFileName(file.name);

      try {
        const supabase = createBrowserClient();

        // Get the user's most recent health_data_upload consent event
        const { data: consentEvent } = await supabase
          .from("consent_events")
          .select("id")
          .eq("user_id", user.userId)
          .eq("consent_type", "health_data_upload")
          .eq("granted", true)
          .order("created_at", { ascending: false })
          .limit(1)
          .single();

        if (!consentEvent) {
          setError("Health data consent is required. Please refresh the page.");
          setUploading(false);
          return;
        }

        // Pre-generate the document ID so we can pass it to the audit page
        const documentId = crypto.randomUUID();
        const storagePath = `${user.userId}/${documentId}.pdf`;

        const { error: uploadError } = await supabase.storage
          .from("documents")
          .upload(storagePath, file, { contentType: "application/pdf" });

        if (uploadError) throw uploadError;

        // Insert document metadata with the pre-generated ID
        const { error: dbError } = await supabase.from("documents").insert({
          id: documentId,
          user_id: user.userId,
          storage_path: storagePath,
          file_name: file.name,
          file_size: file.size,
          doc_type: docType,
          consent_event_id: consentEvent.id,
          status: "uploaded",
        });

        if (dbError) throw dbError;

        // Store document info in sessionStorage so the audit page can auto-process it
        sessionStorage.setItem(
          "pendingAudit",
          JSON.stringify({ documentId, billType: docType, fileName: file.name })
        );

        setUploaded(true);
      } catch (err) {
        console.error("Upload error:", err);
        setError("Upload failed. Please try again.");
      } finally {
        setUploading(false);
      }
    },
    [user, docType]
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { "application/pdf": [".pdf"] },
    maxFiles: 1,
    disabled: uploading,
  });

  if (uploaded) {
    return (
      <div className="max-w-lg">
        <div className="p-6 bg-green-50 border border-green-200 rounded-xl text-center">
          <h3 className="text-lg font-semibold text-green-800">Document Uploaded</h3>
          <p className="mt-2 text-green-700">{fileName} uploaded successfully.</p>
          <p className="mt-3 text-sm text-green-700 bg-green-100 rounded-lg p-3">
            The more bills you upload, the more complete your picture — upload all your
            EOBs and itemized bills, then run the audit to find overcharges across all of them.
          </p>
          <button
            onClick={() => {
              setUploaded(false);
              setFileName("");
            }}
            className="mt-4 px-5 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 text-sm font-medium"
          >
            Upload Another Document
          </button>
          <a
            href="/audit"
            className="mt-3 block text-sm text-blue-600 hover:underline"
          >
            Done uploading — run audit now
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-lg">
      <h1 className="text-2xl font-bold text-gray-900">Upload Document</h1>
      <p className="mt-2 text-gray-600">
        Upload your Explanation of Benefits (EOB) or itemized medical bill for analysis.
      </p>

      <div className="mt-6 space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Document Type</label>
          <select
            value={docType}
            onChange={(e) => setDocType(e.target.value as "eob" | "itemized_bill")}
            className="w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="eob">Explanation of Benefits (EOB)</option>
            <option value="itemized_bill">Itemized Medical Bill</option>
          </select>
        </div>

        <div
          {...getRootProps()}
          className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${
            isDragActive
              ? "border-blue-500 bg-blue-50"
              : "border-gray-300 hover:border-gray-400"
          } ${uploading ? "opacity-50 cursor-not-allowed" : ""}`}
        >
          <input {...getInputProps()} />
          {uploading ? (
            <p className="text-gray-500">Uploading...</p>
          ) : isDragActive ? (
            <p className="text-blue-600">Drop your PDF here</p>
          ) : (
            <div>
              <p className="text-gray-600">Drag and drop a PDF here, or click to select</p>
              <p className="mt-1 text-sm text-gray-400">PDF only, max 20MB</p>
            </div>
          )}
        </div>

        {error && <p className="text-red-600 text-sm">{error}</p>}
      </div>
    </div>
  );
}

export default function UploadPage() {
  return (
    <ConsentGate
      type="health_data_upload"
      declineMessage="You must consent to health data processing before uploading medical documents. This is a separate consent from the Terms of Service, required by law. You can grant this consent at any time."
    >
      <UploadForm />
    </ConsentGate>
  );
}
