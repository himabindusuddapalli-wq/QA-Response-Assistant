/**
 * ――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――
 * Class Name      : QaDocUploadController
 * Author          : <Himabindu>
 * Created Date    : Jun 30, 2026
 * Last Modified By: <himabindu>
 * Last Modified On: Aug 19, 2026
 * Description     : This class implements for......
 *
 * Change History  :
 *  Date          │   Author     │   Change
 * ――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――
 *  Jun 30, 2026  │ Himabindu    │ Initial version
 *  Jul 09, 2026  │ Himabindu    │ Set "Digitization Successful" + notify uploader on question creation
 *  Aug 19, 2026  │ Himabindu    │ Added Review Due Date capture → Due_Date__c on Q_A_Document__c
 * ――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――
 */

public with sharing class QaDocUploadController {

    @AuraEnabled(cacheable=true)
    public static List<Account> searchAccounts(String term) {
        String q = '%' + term + '%';
        return [SELECT Id, Name FROM Account WHERE Name LIKE :q LIMIT 10];
    }

    @AuraEnabled(cacheable=true)
    public static List<Opportunity> searchOpportunities(String term, String accountId) {
        String q = '%' + term + '%';
        if (String.isNotBlank(accountId)) {
            return [SELECT Id, Name FROM Opportunity WHERE Name LIKE :q AND AccountId = :accountId LIMIT 10];
        }
        return [SELECT Id, Name FROM Opportunity WHERE Name LIKE :q LIMIT 10];
    }

    // Auto-populate Company from a selected Membership Activity (Opportunity → Account).
    @AuraEnabled(cacheable=true)
    public static Map<String, String> getOpportunityDetails(String maId) {
        Map<String, String> result = new Map<String, String>();
        if (String.isBlank(maId)) return result;
        List<Opportunity> opps = [
            SELECT Id, AccountId, Account.Name
            FROM Opportunity
            WHERE Id = :maId
            LIMIT 1
        ];
        if (!opps.isEmpty() && opps[0].AccountId != null) {
            result.put('companyId',   opps[0].AccountId);
            result.put('companyName', opps[0].Account.Name);
        }
        return result;
    }

    @AuraEnabled(cacheable=true)
    public static Map<String, String> getRfpDetails(String rfpId) {
        RFP__c rfp = [
            SELECT Id, Name,
                   Membership_Activity__c, Membership_Activity__r.Name,
                   Membership_Activity__r.AccountId, Membership_Activity__r.Account.Name
            FROM RFP__c
            WHERE Id = :rfpId
            LIMIT 1
        ];
        Map<String, String> result = new Map<String, String>();
        result.put('rfpName', rfp.Name);
        if (rfp.Membership_Activity__c != null) {
            result.put('maId',   rfp.Membership_Activity__c);
            result.put('maName', rfp.Membership_Activity__r.Name);
            if (rfp.Membership_Activity__r.AccountId != null) {
                result.put('companyId',   rfp.Membership_Activity__r.AccountId);
                result.put('companyName', rfp.Membership_Activity__r.Account.Name);
            }
        }
        return result;
    }

    @AuraEnabled(cacheable=true)
    public static List<RFP__c> searchRfps(String term, String maId) {
        String q = '%' + term + '%';
        if (String.isNotBlank(maId)) {
            return [SELECT Id, Name FROM RFP__c WHERE Name LIKE :q AND Membership_Activity__c = :maId LIMIT 10];
        }
        return [SELECT Id, Name FROM RFP__c WHERE Name LIKE :q LIMIT 10];
    }

    // ── Upload + create questions (questions parsed client-side via JSZip/SheetJS) ────
    // File attachment is handled separately via attachFileToDocument to avoid
    // the Aura ~4 MB request-body limit.  Large documents chunk questions via
    // addQuestionsToDocument.

    @AuraEnabled
    public static Map<String, Object> uploadAndParseQaDocument(
        String fileName,
        String companyId, String maId, String rfpId,
        String dueDate,
        String questionsJson,
        Integer totalQuestionCount   // optional: full count across all chunks (for email)
    ) {
        try {
            String ext = fileName.contains('.')
                ? fileName.substring(fileName.lastIndexOf('.') + 1).toLowerCase()
                : '';

            // 1. Create Q_A_Document__c record
            Q_A_Document__c doc = new Q_A_Document__c();
            if (String.isNotBlank(companyId)) doc.Company__c = companyId;
            if (String.isNotBlank(maId))      doc.Membership_Activity__c = maId;
            if (String.isNotBlank(rfpId))     doc.RFP__c = rfpId;
            Date parsedDueDate = parseDueDate(dueDate);
            if (parsedDueDate != null) doc.Due_Date__c = parsedDueDate;
            doc.File_Type__c = ext;
            doc.Q_A_Doc_Owner__c = UserInfo.getUserId();
            insert doc;

            // 2. Bulk-insert Q_A_Question__c (first chunk or all, depending on caller)
            List<Q_A_Question__c> questions = parseQuestionsFromJson(doc.Id, questionsJson, 0);
            if (!questions.isEmpty()) {
                insert questions;
            }

            // 3. Initialise question counters — nothing has been reviewed yet
            Integer countForEmail = totalQuestionCount != null ? totalQuestionCount : questions.size();
            doc.Total_Questions__c     = countForEmail;
            doc.Finalized_Questions__c = 0;
            doc.Pending_Questions__c   = countForEmail;
            if (!questions.isEmpty()) {
                doc.Status__c = 'Digitization Successful';
            }
            update doc;

            Map<String, Object> result = new Map<String, Object>();
            result.put('docId', doc.Id);
            result.put('questionCount', totalQuestionCount != null ? totalQuestionCount : questions.size());
            return result;

        } catch (Exception e) {
            throw new AuraHandledException('Upload failed: ' + e.getMessage());
        }
    }

    // ── Insert additional question chunks (called when questionsJson is too large
    //    to send in a single Aura request alongside the other parameters) ─────────

    @AuraEnabled
    public static Integer addQuestionsToDocument(Id documentId, String questionsJson, Integer offset) {
        try {
            List<Q_A_Question__c> questions = parseQuestionsFromJson(
                documentId, questionsJson, offset != null ? offset : 0
            );
            if (!questions.isEmpty()) insert questions;
            return questions.size();
        } catch (Exception e) {
            throw new AuraHandledException('Failed to add questions: ' + e.getMessage());
        }
    }

    // ── Attach the original file to the document (called separately to keep the
    //    main upload payload small — avoids Aura 4 MB request-body limit) ────────

    @AuraEnabled
    public static void attachFileToDocument(Id documentId, String base64Data, String fileName) {
        try {
            if (String.isBlank(base64Data) || documentId == null) return;
            ContentVersion cv = new ContentVersion();
            cv.Title                  = fileName;
            cv.PathOnClient           = fileName;
            cv.VersionData            = EncodingUtil.base64Decode(base64Data);
            cv.FirstPublishLocationId = documentId;
            insert cv;
        } catch (Exception e) {
            throw new AuraHandledException('File attachment failed: ' + e.getMessage());
        }
    }

    // ── Upload + create questions for PDF files (extraction happens server-side
    //    via Data Cloud Document AI, unlike the client-side Word/Excel parsing
    //    above) — the Word/Excel methods above are untouched by this addition ──

    private static final String DOC_AI_NAMED_CREDENTIAL = 'Data_Cloud_Document_AI';
    private static final String DOC_AI_SCHEMA_NAME       = 'PDF_Question_Extraction';

    @AuraEnabled
    public static Map<String, Object> uploadAndParsePdfDocument(
        String fileName,
        String companyId, String maId, String rfpId,
        String dueDate,
        String base64Data
    ) {
        try {
            // 1. Create the document record immediately so the UI has a record to poll
            Q_A_Document__c doc = new Q_A_Document__c();
            if (String.isNotBlank(companyId)) doc.Company__c = companyId;
            if (String.isNotBlank(maId))      doc.Membership_Activity__c = maId;
            if (String.isNotBlank(rfpId))     doc.RFP__c = rfpId;
            Date parsedDueDate = parseDueDate(dueDate);
            if (parsedDueDate != null) doc.Due_Date__c = parsedDueDate;
            doc.File_Type__c     = 'pdf';
            doc.Q_A_Doc_Owner__c = UserInfo.getUserId();
            doc.Status__c        = 'Digitization In-Progress';
            insert doc;

            // 2. Attach the PDF — the Queueable reads the bytes back from here
            ContentVersion cv = new ContentVersion();
            cv.Title                  = fileName;
            cv.PathOnClient           = fileName;
            cv.VersionData            = EncodingUtil.base64Decode(base64Data);
            cv.FirstPublishLocationId = doc.Id;
            insert cv;

            // 3. Enqueue async extraction — callout + question creation + email happen
            //    in the background so the upload never times out for large PDFs.
            System.enqueueJob(new PdfExtractionQueueable(doc.Id, cv.Id, 0, UserInfo.getUserId()));

            return new Map<String, Object>{ 'docId' => doc.Id };

        } catch (Exception e) {
            throw new AuraHandledException('PDF upload failed: ' + e.getMessage());
        }
    }

    @AuraEnabled
    public static Map<String, Object> getPdfExtractionStatus(Id documentId) {
        try {
            Q_A_Document__c doc = [
                SELECT Status__c, Total_Questions__c
                FROM Q_A_Document__c
                WHERE Id = :documentId
                LIMIT 1
            ];
            return new Map<String, Object>{
                'status'        => doc.Status__c,
                'questionCount' => doc.Total_Questions__c
            };
        } catch (Exception e) {
            throw new AuraHandledException(e.getMessage());
        }
    }

    // Builds Q_A_Question__c records from Document AI extracted rows.
    // Called by PdfExtractionQueueable after the callout completes.
    public static List<Q_A_Question__c> buildQuestionsFromRows(Id docId, List<Map<String, Object>> extractedRows) {
        List<Q_A_Question__c> questions = new List<Q_A_Question__c>();
        for (Integer i = 0; i < extractedRows.size(); i++) {
            Map<String, Object> row = extractedRows[i];
            Object qVal = row.get('Question');
            if (qVal == null || String.isBlank(String.valueOf(qVal))) continue;

            Q_A_Question__c q = new Q_A_Question__c();
            q.Q_A_Document__c = docId;
            q.Status__c        = 'New';
            q.QAQuestion__c    = String.valueOf(qVal).trim();

            Object secVal = row.get('Section');
            if (secVal != null && String.isNotBlank(String.valueOf(secVal))) {
                q.Section__c = String.valueOf(secVal).trim().left(255);
            }

            Object noVal = row.get('Question Number');
            String noStr = noVal != null ? String.valueOf(noVal).trim() : '';
            q.QAQuestionNo__c = String.isNotBlank(noStr) ? noStr : String.valueOf(i + 1);

            Object limitVal = row.get('Answer Size Limit');
            if (limitVal != null) {
                try {
                    String lRaw = String.valueOf(limitVal).trim();
                    if (String.isNotBlank(lRaw)) q.Answer_Size_Limit__c = lRaw;
                } catch (Exception ex) {}
            }

            questions.add(q);
        }
        return questions;
    }

    // Calls Data Cloud Document AI (PDF_Question_Extraction_Schema) to extract
    // questions from a PDF. Public so PdfExtractionQueueable can call it.
    public static List<Map<String, Object>> extractQuestionsFromPdf(String base64Data) {
        if (String.isBlank(base64Data)) return new List<Map<String, Object>>();

        Map<String, Object> file = new Map<String, Object>{
            'mimeType' => 'application/pdf',
            'data'     => base64Data
        };
        Map<String, Object> body = new Map<String, Object>{
            'idpConfigurationIdOrName' => DOC_AI_SCHEMA_NAME,
            'files'                    => new List<Object>{ file }
        };

        HttpRequest req = new HttpRequest();
        req.setEndpoint('callout:' + DOC_AI_NAMED_CREDENTIAL
            + '/services/data/v66.0/ssot/document-processing/actions/extract-data?htmlEncode=false');
        req.setMethod('POST');
        req.setHeader('Content-Type', 'application/json');
        req.setBody(JSON.serialize(body));
        req.setTimeout(120000);

        Http http = new Http();
        HttpResponse res = http.send(req);

        // Document AI returns 200/201/202 on success, not just 200.
        Set<Integer> successCodes = new Set<Integer>{ 200, 201, 202 };
        if (!successCodes.contains(res.getStatusCode())) {
            System.debug('Document AI extract-data failed [' + res.getStatusCode() + ']: ' + res.getBody());
            throw new AuraHandledException(
                'Document AI extraction failed (HTTP ' + res.getStatusCode() + '): ' + res.getBody().left(500)
            );
        }

        return parseExtractionTableRows(res.getBody());
    }

    // The response envelope wraps the extraction result in a double-encoded
    // JSON string, with every field/table wrapped in {"type":..,"value":..}:
    //   {"data": [ { "data": "<json string>" } ] }
    // and the decoded inner JSON looks like:
    //   {"Extraction Table": {"type":"array","value": [
    //       {"type":"object","value": {"Section": {"type":"string","value":"..."}, ...}}
    //   ]}}
    private static List<Map<String, Object>> parseExtractionTableRows(String rawResponse) {
        Object outerResult = JSON.deserializeUntyped(rawResponse);
        Map<String, Object> outerMap = (outerResult instanceof Map<String, Object>) ? (Map<String, Object>) outerResult : null;
        List<Object> dataList = (outerMap != null && outerMap.get('data') instanceof List<Object>)
            ? (List<Object>) outerMap.get('data')
            : null;
        if (dataList == null || dataList.isEmpty()) {
            throw new AuraHandledException('Document AI response had no data. Raw response: ' + rawResponse.left(500));
        }

        Map<String, Object> firstData = (Map<String, Object>) dataList[0];
        String encodedJson = (String) firstData.get('data');
        if (String.isBlank(encodedJson)) {
            throw new AuraHandledException('Document AI response was missing the extracted data payload.');
        }

        String decodedJson = encodedJson
            .replace('&quot;', '"').replace('&#34;', '"').replace('&apos;', '\'')
            .replace('&#39;', '\'').replace('&lt;', '<').replace('&#60;', '<')
            .replace('&gt;', '>').replace('&#62;', '>').replace('&nbsp;', ' ')
            .replace('&amp;', '&');

        Map<String, Object> fields = (Map<String, Object>) JSON.deserializeUntyped(decodedJson);
        List<Object> rawRows = unwrapListValue(fields.get('Extraction Table'));
        if (rawRows == null) {
            throw new AuraHandledException(
                'Document AI response did not contain the expected "Extraction Table" data. Raw response: '
                + rawResponse.left(500)
            );
        }

        List<Map<String, Object>> rows = new List<Map<String, Object>>();
        for (Object rowObj : rawRows) {
            Map<String, Object> rowWrapper = (Map<String, Object>) rowObj;
            Object rowValue = rowWrapper.get('value');
            Map<String, Object> row = (rowValue instanceof Map<String, Object>)
                ? (Map<String, Object>) rowValue
                : rowWrapper;

            Map<String, Object> flatRow = new Map<String, Object>();
            flatRow.put('Section', unwrapFieldValue(row.get('Section')));
            flatRow.put('Question Number', unwrapFieldValue(row.get('Question Number')));
            flatRow.put('Question', unwrapFieldValue(row.get('Question')));
            flatRow.put('Answer Size Limit', unwrapFieldValue(row.get('Answer size limit')));
            rows.add(flatRow);
        }
        return rows;
    }

    // "Extraction Table" arrives as {"type":"array","value":[...]} — unwrap to the list.
    private static List<Object> unwrapListValue(Object tableRaw) {
        if (tableRaw instanceof List<Object>) return (List<Object>) tableRaw;
        if (tableRaw instanceof Map<String, Object>) {
            Object val = ((Map<String, Object>) tableRaw).get('value');
            if (val instanceof List<Object>) return (List<Object>) val;
        }
        return null;
    }

    // Each field arrives as {"type":"string","value":"..."} — unwrap to the raw value.
    // Also strips any HTML closing tags (</body></html>) that Document AI appends
    // to the last field value in the response.
    private static Object unwrapFieldValue(Object fieldObj) {
        if (fieldObj instanceof Map<String, Object>) {
            Object val = ((Map<String, Object>) fieldObj).get('value');
            if (val instanceof String) {
                return ((String) val).replaceAll('<[^>]+>', '').trim();
            }
            return val;
        }
        return fieldObj;
    }

    // ── Shared helper: deserialise questionsJson → Q_A_Question__c list ─────────

    private static List<Q_A_Question__c> parseQuestionsFromJson(Id docId, String questionsJson, Integer offset) {
        List<Q_A_Question__c> questions = new List<Q_A_Question__c>();
        if (String.isBlank(questionsJson) || questionsJson == '[]') return questions;
        List<Object> parsed = (List<Object>) JSON.deserializeUntyped(questionsJson);
        for (Integer i = 0; i < parsed.size(); i++) {
            Map<String, Object> pq = (Map<String, Object>) parsed[i];
            Q_A_Question__c q = new Q_A_Question__c();
            q.Q_A_Document__c = docId;
            q.Status__c = 'New';

            Object noVal = pq.get('no');
            String noRaw = noVal != null ? String.valueOf(noVal).trim() : '';
            q.QAQuestionNo__c = String.isNotBlank(noRaw) ? noRaw : String.valueOf(offset + i + 1);

            Object secVal = pq.get('section');
            if (secVal != null && String.isNotBlank(String.valueOf(secVal))) {
                q.Section__c = String.valueOf(secVal).trim().left(255);
            }

            Object qVal = pq.get('question');
            if (qVal != null) q.QAQuestion__c = String.valueOf(qVal).trim();

            Object limitVal = pq.get('answerLimit');
            if (limitVal != null) {
                try {
                    String lRaw = String.valueOf(limitVal).trim();
                    if (String.isNotBlank(lRaw)) q.Answer_Size_Limit__c = lRaw;
                } catch (Exception ex) {}
            }

            if (q.QAQuestion__c != null && !q.QAQuestion__c.trim().equals('')) {
                questions.add(q);
            }
        }
        return questions;
    }

    // Parses the ISO "YYYY-MM-DD" string sent by lightning-input type="date" into
    // a Date. Returns null (rather than throwing) on blank or malformed input so
    // an upload never fails outright over the due date alone.
    private static Date parseDueDate(String dueDate) {
        if (String.isBlank(dueDate)) return null;
        try {
            return Date.valueOf(dueDate);
        } catch (Exception e) {
            System.debug('parseDueDate failed for value "' + dueDate + '": ' + e.getMessage());
            return null;
        }
    }

    // Called by the LWC when Word/Excel processing takes longer than the 2-second
    // threshold — reads the saved question count from the document record.
    @AuraEnabled
    public static void notifyQuestionsProcessed(Id documentId) {
        try {
            Q_A_Document__c doc = [
                SELECT Total_Questions__c
                FROM Q_A_Document__c
                WHERE Id = :documentId
                LIMIT 1
            ];
            Integer count = doc.Total_Questions__c != null ? (Integer) doc.Total_Questions__c : 0;
            sendDigitizationEmail(documentId, count);
        } catch (Exception e) {
            System.debug('notifyQuestionsProcessed failed: ' + e.getMessage());
        }
    }

    // ── Digitization-success notification (Merit template) ───────────────────

  // ── Digitization-success notification (Merit template) ───────────────────

    public static void sendDigitizationEmail(Id documentId, Integer questionCount) {
    try {
        Q_A_Document__c doc = [
            SELECT Id, Name, Owner.Email, Owner.Name,
                   RFP__c, RFP__r.Name,
                   Membership_Activity__c, Membership_Activity__r.Name
            FROM Q_A_Document__c
            WHERE Id = :documentId
            LIMIT 1
        ];

        String toEmail = doc.Owner.Email;
        if (String.isBlank(toEmail)) {
            User u = [SELECT Email FROM User WHERE Id = :UserInfo.getUserId() LIMIT 1];
            toEmail = u.Email;
        }
        if (String.isBlank(toEmail)) return;

        String userName = String.isNotBlank(doc.Owner.Name) ? doc.Owner.Name : 'there';
        String orgUrl   = URL.getOrgDomainUrl().toExternalForm();

        // Q&A Document Link
        String docLink = orgUrl + '/lightning/r/Q_A_Document__c/' + doc.Id + '/view';

        // Uploaded file name — pulled from the attached ContentVersion (original upload).
        String fileName = doc.Name;   // fallback if no file is found
        List<ContentDocumentLink> links = [
            SELECT ContentDocumentId
            FROM ContentDocumentLink
            WHERE LinkedEntityId = :documentId
        ];
        if (!links.isEmpty()) {
            Set<Id> cdIds = new Set<Id>();
            for (ContentDocumentLink l : links) cdIds.add(l.ContentDocumentId);
            List<ContentVersion> cvs = [
                SELECT Title
                FROM ContentVersion
                WHERE ContentDocumentId IN :cdIds AND IsLatest = true
                ORDER BY CreatedDate ASC
                LIMIT 1
            ];
            if (!cvs.isEmpty() && String.isNotBlank(cvs[0].Title)) {
                fileName = cvs[0].Title;
            }
        }

        String html =
            '<div style="font-family:Arial,sans-serif;color:#333;font-size:14px;line-height:1.6;">'
          + '<p>Hi ' + userName + ',</p>'
          + '<p>Your uploaded file <b>' + fileName + '</b> has been successfully processed, and draft responses '
          + 'are now available for your review. Click the link below to open the Q&amp;A Document and review the '
          + 'generated responses:</p>'
          + '<ul>'
          + '<li><b>Q&amp;A Document:</b> <a href="' + docLink + '">' + doc.Name + '</a></li>'
          + '<li><b>Total Number of Questions Processed:</b> ' + questionCount + '</li>'
          + '</ul>'
          + '<p>Once you open the document, you can review, edit, style, and finalize each response.</p>'
          + '<p>Best regards,<br/>Q&amp;A Response Assistant</p>'
          + '<hr style="border:none;border-top:1px solid #e0e0e0;margin:20px 0;"/>'
          + '<p style="font-size:12px;color:#888;line-height:1.5;">'
          + 'This is an automated notification — please do not reply to this email.<br/>'
          + 'For any questions regarding the generated responses, please contact the Merit team at '
          + '<a href="mailto:lbpoluru@uhc.com">lbpoluru@uhc.com</a> or '
          + '<a href="mailto:merit@uhc.com">merit@uhc.com</a>.'
          + '</p>'
          + '</div>';

        Messaging.SingleEmailMessage mail = new Messaging.SingleEmailMessage();
        mail.setToAddresses(new List<String>{ toEmail });
        mail.setSubject('Q&A Document Processed – ' + fileName);
        mail.setHtmlBody(html);
        mail.setSaveAsActivity(false);

        Messaging.sendEmail(new List<Messaging.SingleEmailMessage>{ mail });

    } catch (Exception e) {
        System.debug('sendDigitizationEmail failed: ' + e.getMessage());
    }
}
    // ── Kick off async answer-matching for a document ────────────────────────

    @AuraEnabled
    public static void startAnswerSearchBatch(Id documentId) {
        try {
            update new Q_A_Document__c(Id = documentId, Status__c = 'Digitization In-Progress');
            Database.executeBatch(
                new QnaAnswerSearchBatchProcessor(documentId, UserInfo.getUserId()),
                1  // batch size 1 — one callout per transaction
            );
        } catch (Exception e) {
            throw new AuraHandledException('Failed to start batch: ' + e.getMessage());
        }
    }
     public static void updateMatchesFoundCount(Id documentId) {
        if (documentId == null) return;

        Integer matchesFound = 0;
        AggregateResult[] ars = [
            SELECT COUNT_DISTINCT(Q_A_Question__c) qcount
            FROM Q_A_Answer__c
            WHERE Q_A_Question__r.Q_A_Document__c = :documentId
              AND Is_Relevant__c = true
        ];
        if (!ars.isEmpty() && ars[0].get('qcount') != null) {
            matchesFound = (Integer) ars[0].get('qcount');
        }

        update new Q_A_Document__c(
            Id = documentId,
           Questions_with_Matches_Found__c = matchesFound
        );
    }
    
}