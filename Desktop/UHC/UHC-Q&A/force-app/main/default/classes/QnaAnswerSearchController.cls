/**
 * @description       : Fetches top-3 Data Cloud answers for a Q&A question and persists them as Q_A_Answer__c records.
 * @author            : Ambika
 * @last modified on  : 07-30-2026
**/
public with sharing class QnaAnswerSearchController {

    @TestVisible
    private static IDataCloudService dataCloudService = new DataCloudService();

    // ── Public API ──────────────────────────────────────────────────────────

    @AuraEnabled
    public static Map<Id, List<Q_A_Answer__c>> getAnswersForAllQuestions(List<Id> questionIds) {
        try {
            Map<Id, List<Q_A_Answer__c>> result = new Map<Id, List<Q_A_Answer__c>>();
            if (questionIds == null || questionIds.isEmpty()) return result;

            // One query for all questions; ORDER BY qId then score so we take top-3 per question below
            List<Q_A_Answer__c> all = [
                SELECT Id, Answer__c, Company__c, Consulting_Firm__c,
                       Effective_Period__c, File_Name__c, Industry__c,
                       Match_Score__c, Vector_Score__c, Keyword_Score__c,
                       RFP_Name__c, SVP_Name__c,
                       Topic_Area__c, Is_Selected_Answer__c, D360_Data_Source_ID__c,
                       Q_A_Question__c
                FROM Q_A_Answer__c
                WHERE Q_A_Question__c IN :questionIds
                  AND Is_Relevant__c = true
                WITH USER_MODE
                ORDER BY Q_A_Question__c ASC, Id ASC
            ];

            // Enrich with Match_Quality__c via a separate query — the field is excluded from
            // the USER_MODE query above because newly deployed fields may lack FLS grants.
            Set<Id> allIds = (new Map<Id, Q_A_Answer__c>(all)).keySet();
            Map<Id, String> qualityMap = new Map<Id, String>();
            for (Q_A_Answer__c a : [SELECT Id, Match_Quality__c FROM Q_A_Answer__c WHERE Id IN :allIds]) {
                qualityMap.put(a.Id, a.Match_Quality__c);
            }
            for (Q_A_Answer__c a : all) {
                a.Match_Quality__c = qualityMap.get(a.Id);
            }

            Map<Id, Integer> counts = new Map<Id, Integer>();
            for (Q_A_Answer__c a : all) {
                Id qId = a.Q_A_Question__c;
                if (!result.containsKey(qId)) {
                    result.put(qId, new List<Q_A_Answer__c>());
                    counts.put(qId, 0);
                }
                if (counts.get(qId) < 3) {
                    result.get(qId).add(a);
                    counts.put(qId, counts.get(qId) + 1);
                }
            }
            return result;
        } catch (Exception e) {
            throw new AuraHandledException(e.getMessage());
        }
    }

    @AuraEnabled
    public static List<Q_A_Answer__c> getAnswersForQuestion(Id questionId, String questionText) {
        try {
            List<Q_A_Answer__c> answers = [
                SELECT Id, Answer__c, Company__c, Consulting_Firm__c,
                       Effective_Period__c, File_Name__c, Industry__c,
                       Match_Score__c, Vector_Score__c, Keyword_Score__c,
                       RFP_Name__c, SVP_Name__c,
                       Topic_Area__c, Is_Selected_Answer__c, D360_Data_Source_ID__c
                FROM Q_A_Answer__c
                WHERE Q_A_Question__c = :questionId
                  AND Is_Relevant__c = true
                WITH USER_MODE
                ORDER BY Id ASC
                LIMIT 3
            ];
            // Enrich with Match_Quality__c separately to avoid FLS issues on newly deployed field
            Set<Id> ids = (new Map<Id, Q_A_Answer__c>(answers)).keySet();
            Map<Id, String> qualityMap = new Map<Id, String>();
            for (Q_A_Answer__c a : [SELECT Id, Match_Quality__c FROM Q_A_Answer__c WHERE Id IN :ids]) {
                qualityMap.put(a.Id, a.Match_Quality__c);
            }
            for (Q_A_Answer__c a : answers) a.Match_Quality__c = qualityMap.get(a.Id);
            return answers;
        } catch (Exception e) {
            throw new AuraHandledException(e.getMessage());
        }
    }

    // Public so QnaAnswerSearchBatchProcessor can call it directly
    public static List<Q_A_Answer__c> fetchAndStoreAnswers(Id questionId, String questionText) {
        return fetchAndStoreAnswers(questionId, questionText, null);
    }

    public static List<Q_A_Answer__c> fetchAndStoreAnswers(Id questionId, String questionText, String preferredConsultingFirm) {
        List<Q_A_Answer__c> result = new List<Q_A_Answer__c>();

        List<Q_A_Response_Assistant__mdt> cfgList = [
            SELECT QA_SQL_Query__c,
                   QA_Question_Field_API_Name__c,
                   QA_Answer_Field_API_Name__c,
                   QA_Hybrid_Score_Field_API_Name__c,
                   QA_Vector_Score_Field_API_Name__c,
                   QA_Keyword_Score_Field_API_Name__c,
                   QA_Date_Field_API_Name__c,
                   QA_Company_Field_API_Name__c,
                   QA_Consulting_Firm_Field_API_Name__c,
                   QA_RFP_Field_API_Name__c,
                   QA_Industry_Field_API_Name__c,
                   QA_SVP_Name_Field_API_Name__c,
                   QA_Topic_Area_Field_API_Name__c
            FROM Q_A_Response_Assistant__mdt
            WHERE DeveloperName = 'Q_A_Response_Assistant'
            LIMIT 1
        ];
        if (cfgList.isEmpty()) return result;
        Q_A_Response_Assistant__mdt cfg = cfgList[0];

        if (String.isBlank(cfg.QA_SQL_Query__c) || !cfg.QA_SQL_Query__c.contains('{{QUESTION}}')) {
            return result;
        }

        String safeQuestion = questionText.trim().replace('\'', '\'\'');
        String finalSql = cfg.QA_SQL_Query__c
            .replace('{{QUESTION}}', safeQuestion)
            .replaceAll('[\\n\\r]+', ' ');

        ConnectApi.CdpQueryOutputV2 output;
        try {
            output = dataCloudService.runQuery(finalSql);
        } catch (Exception e) {
            System.debug('QnaAnswerSearch Data Cloud query failed: ' + e.getMessage());
            return result;
        }

        if (output == null || output.data == null || output.data.isEmpty()) return result;

        // Resolve column positions from metadata
        Map<String, Integer> colMap = new Map<String, Integer>();
        for (String colName : output.metadata.keySet()) {
            ConnectApi.CdpQueryMetadataItem meta = (ConnectApi.CdpQueryMetadataItem) output.metadata.get(colName);
            if (meta != null && meta.placeInOrder != null) {
                colMap.put(colName, meta.placeInOrder);
            }
        }

        Integer questionIdx = colMap.get(cfg.QA_Question_Field_API_Name__c);
        Integer answerIdx   = colMap.get(cfg.QA_Answer_Field_API_Name__c);
        Integer hybridIdx   = colMap.get(cfg.QA_Hybrid_Score_Field_API_Name__c);
        Integer vectorIdx   = colMap.get(cfg.QA_Vector_Score_Field_API_Name__c);
        Integer keywordIdx  = colMap.get(cfg.QA_Keyword_Score_Field_API_Name__c);
        Integer dateIdx     = colMap.get(cfg.QA_Date_Field_API_Name__c);
        Integer companyIdx  = colMap.get(cfg.QA_Company_Field_API_Name__c);
        Integer firmIdx     = colMap.get(cfg.QA_Consulting_Firm_Field_API_Name__c);
        Integer rfpIdx      = colMap.get(cfg.QA_RFP_Field_API_Name__c);
        Integer industryIdx = colMap.get(cfg.QA_Industry_Field_API_Name__c);
        Integer svpIdx      = colMap.get(cfg.QA_SVP_Name_Field_API_Name__c);
        Integer topicIdx    = colMap.get(cfg.QA_Topic_Area_Field_API_Name__c);

        if (hybridIdx == null || answerIdx == null) return result;

        // Build candidate list from all rows returned by Data Cloud
        List<AnswerCandidate> candidates = new List<AnswerCandidate>();

        for (ConnectApi.CdpQueryV2Row row : output.data) {
            List<Object> cols = row.rowData;

            Decimal hybridScore = Decimal.valueOf((String) cols[hybridIdx]).setScale(2);
            if (hybridScore < 0.60) continue;

            Q_A_Answer__c ans = new Q_A_Answer__c();
            ans.Q_A_Question__c        = questionId;
            ans.Answer__c              = (String) cols[answerIdx];
            ans.Match_Score__c         = hybridScore;
            ans.D360_Data_Source_ID__c = questionIdx != null ? (String) cols[questionIdx] : null;

            if (vectorIdx  != null && cols[vectorIdx]  != null) ans.Vector_Score__c  = Decimal.valueOf((String) cols[vectorIdx]).setScale(2);
            if (keywordIdx != null && cols[keywordIdx] != null) ans.Keyword_Score__c = Decimal.valueOf((String) cols[keywordIdx]).setScale(2);

            if (dateIdx     != null && cols[dateIdx]     != null) ans.Effective_Period__c = String.valueOf(cols[dateIdx]);
            if (companyIdx  != null && cols[companyIdx]  != null) ans.Company__c          = String.valueOf(cols[companyIdx]);
            if (firmIdx     != null && cols[firmIdx]     != null) ans.Consulting_Firm__c  = String.valueOf(cols[firmIdx]);
            if (rfpIdx      != null && cols[rfpIdx]      != null) ans.RFP_Name__c         = String.valueOf(cols[rfpIdx]);
            if (industryIdx != null && cols[industryIdx] != null) ans.Industry__c         = String.valueOf(cols[industryIdx]);
            if (svpIdx      != null && cols[svpIdx]      != null) ans.SVP_Name__c         = String.valueOf(cols[svpIdx]);
            if (topicIdx    != null && cols[topicIdx]    != null) ans.Topic_Area__c       = String.valueOf(cols[topicIdx]);

            Boolean firmMatch = String.isNotBlank(preferredConsultingFirm)
                && String.isNotBlank(ans.Consulting_Firm__c)
                && ans.Consulting_Firm__c.equalsIgnoreCase(preferredConsultingFirm);

            candidates.add(new AnswerCandidate(ans, firmMatch));
        }

        // Rank: (1) hybrid score desc, (2) same consulting firm first, (3) recency desc
        candidates.sort();

        List<Q_A_Answer__c> toInsert = new List<Q_A_Answer__c>();
        Set<String> seenAnswers   = new Set<String>();
        Set<String> seenMatchedQs = new Set<String>();
        for (AnswerCandidate c : candidates) {
            if (toInsert.size() >= 3) break;
            String answerKey = c.rec.Answer__c != null ? c.rec.Answer__c.left(200).normalizeSpace() : '';
            if (seenAnswers.contains(answerKey)) continue;
            String matchedQKey = String.isNotBlank(c.rec.D360_Data_Source_ID__c)
                ? c.rec.D360_Data_Source_ID__c.left(200).normalizeSpace() : '';
            if (String.isNotBlank(matchedQKey) && seenMatchedQs.contains(matchedQKey)) continue;
            seenAnswers.add(answerKey);
            if (String.isNotBlank(matchedQKey)) seenMatchedQs.add(matchedQKey);
            toInsert.add(c.rec);
        }

        if (!toInsert.isEmpty()) {
            // Default all candidates to relevant; relevance check may flip some to false
            for (Q_A_Answer__c a : toInsert) {
                a.Is_Relevant__c = true;
            }

            // Run relevance check before DML (callout not allowed after DML)
            // Fall back to answer text when D360_Data_Source_ID__c is blank so the
            // check still runs — skipping entirely because one field is blank was
            // silently keeping irrelevant matches visible.
            List<String> matchQs = new List<String>();
            for (Q_A_Answer__c a : toInsert) {
                String qt = a.D360_Data_Source_ID__c;
                if (String.isBlank(qt)) {
                    qt = String.isNotBlank(a.Answer__c) ? a.Answer__c.left(500) : '';
                    System.debug(LoggingLevel.WARN, 'QnaAnswerSearch [' + questionId + ']: D360_Data_Source_ID__c blank — using answer text as fallback for relevance check');
                }
                matchQs.add(qt);
            }
            System.debug(LoggingLevel.INFO, 'QnaAnswerSearch [' + questionId + ']: calling checkMatchRelevanceByText. questionText=' + questionText.left(100) + ' matchQs=' + matchQs);
            String relevanceJson = QnaAIActionsController.checkMatchRelevanceByText(questionText, matchQs);
            System.debug(LoggingLevel.INFO, 'QnaAnswerSearch [' + questionId + ']: relevanceJson=' + relevanceJson);
            if (String.isNotBlank(relevanceJson)) {
                Map<Integer, Integer> rankMap = setRelevanceFlags(toInsert, relevanceJson);
                toInsert = sortByRank(toInsert, rankMap);
            } else {
                System.debug(LoggingLevel.WARN, 'QnaAnswerSearch [' + questionId + ']: relevanceJson blank — LLM callout failed or returned empty; all ' + toInsert.size() + ' answers kept relevant');
            }

            // Delete old answers then store all candidates with Is_Relevant__c set
            List<Q_A_Answer__c> existing = [
                SELECT Id FROM Q_A_Answer__c
                WHERE Q_A_Question__c = :questionId
                WITH USER_MODE
            ];
            if (!existing.isEmpty()) delete existing;

            insert toInsert;
            result = toInsert;
        }
        return result;
    }

    /**
     * Runs a fresh Data Cloud hybrid search scoped by active filter criteria.
     * Uses Custom_Search__mdt which has a {{PREFILTER}} placeholder that is
     * passed directly into hybrid_search() — filters are applied at the vector
     * search level, not in Apex after the fact.
     * Results are NOT saved to the database — they are for display only.
     */
    @AuraEnabled
    public static List<Q_A_Answer__c> searchWithFilters(
        Id questionId, String questionText,
        String filterCompany, String filterConsultingFirm, String filterIndustry,
        String filterRfpName, String filterSvpName, String filterTopicArea, String filterFileName
    ) {
        try {
            List<Custom_Search__mdt> cfgList = [
                SELECT SQL_Query__c, Question_Field_API_Name__c, Answer_Field_API_Name__c,
                       Hybrid_Score_Field_API_Name__c, Vector_Score_Field_API_Name__c,
                       Date_Field_API_Name__c, Company_Field_API_Name__c,
                       Consulting_Firm_Field_API_Name__c, RFP_Field_API_Name__c,
                       Industry_Field_API_Name__c, SVP_Name_Field_API_Name__c,
                       Topic_Area_Field_API_Name__c
                FROM Custom_Search__mdt
                WHERE DeveloperName = 'Q_A_Response_Assistant_Custom_Search'
                LIMIT 1
            ];
            if (cfgList.isEmpty()) return new List<Q_A_Answer__c>();
            Custom_Search__mdt cfg = cfgList[0];

            if (String.isBlank(cfg.SQL_Query__c) || !cfg.SQL_Query__c.contains('{{QUESTION}}'))
                return new List<Q_A_Answer__c>();

            // Build prefilter conditions — values are escaped with doubled single quotes
            // because the {{PREFILTER}} placeholder sits inside SQL single-quote delimiters.
            List<String> conditions = new List<String>();
            if (String.isNotBlank(filterCompany))        conditions.add(cfg.Company_Field_API_Name__c        + ' = \'\'' + filterCompany.replace('\'', '\'\'\'\'')        + '\'\'');
            if (String.isNotBlank(filterConsultingFirm)) conditions.add(cfg.Consulting_Firm_Field_API_Name__c + ' = \'\'' + filterConsultingFirm.replace('\'', '\'\'\'\'') + '\'\'');
            if (String.isNotBlank(filterIndustry))       conditions.add(cfg.Industry_Field_API_Name__c       + ' = \'\'' + filterIndustry.replace('\'', '\'\'\'\'')       + '\'\'');
            if (String.isNotBlank(filterRfpName))        conditions.add(cfg.RFP_Field_API_Name__c            + ' = \'\'' + filterRfpName.replace('\'', '\'\'\'\'')        + '\'\'');
            if (String.isNotBlank(filterSvpName))        conditions.add(cfg.SVP_Name_Field_API_Name__c       + ' = \'\'' + filterSvpName.replace('\'', '\'\'\'\'')        + '\'\'');
            if (String.isNotBlank(filterTopicArea))      conditions.add(cfg.Topic_Area_Field_API_Name__c     + ' = \'\'' + filterTopicArea.replace('\'', '\'\'\'\'')      + '\'\'');

            String prefilter    = String.join(conditions, ' AND ');
            String safeQuestion = questionText.trim().replace('\'', '\'\'');
            // {{TOP_N}} is an optional placeholder — if the SQL template includes it,
            // we fetch a larger pool so Apex-level post-filtering has more to work with.
            String finalSql = cfg.SQL_Query__c
                .replace('{{QUESTION}}', safeQuestion)
                .replace('{{PREFILTER}}', prefilter)
                .replace('{{TOP_N}}', '15')
                .replaceAll('[\\n\\r]+', ' ');

            ConnectApi.CdpQueryOutputV2 output;
            try {
                output = dataCloudService.runQuery(finalSql);
            } catch (Exception e) {
                System.debug('searchWithFilters DC query failed: ' + e.getMessage());
                return new List<Q_A_Answer__c>();
            }

            if (output == null || output.data == null || output.data.isEmpty())
                return new List<Q_A_Answer__c>();

            Map<String, Integer> colMap = new Map<String, Integer>();
            for (String colName : output.metadata.keySet()) {
                ConnectApi.CdpQueryMetadataItem meta = (ConnectApi.CdpQueryMetadataItem) output.metadata.get(colName);
                if (meta != null && meta.placeInOrder != null) colMap.put(colName, meta.placeInOrder);
            }

            Integer questionIdx = colMap.get(cfg.Question_Field_API_Name__c);
            Integer answerIdx   = colMap.get(cfg.Answer_Field_API_Name__c);
            Integer hybridIdx   = colMap.get(cfg.Hybrid_Score_Field_API_Name__c);
            Integer vectorIdx   = colMap.get(cfg.Vector_Score_Field_API_Name__c);
            Integer dateIdx     = colMap.get(cfg.Date_Field_API_Name__c);
            Integer companyIdx  = colMap.get(cfg.Company_Field_API_Name__c);
            Integer firmIdx     = colMap.get(cfg.Consulting_Firm_Field_API_Name__c);
            Integer rfpIdx      = colMap.get(cfg.RFP_Field_API_Name__c);
            Integer industryIdx = colMap.get(cfg.Industry_Field_API_Name__c);
            Integer svpIdx      = colMap.get(cfg.SVP_Name_Field_API_Name__c);
            Integer topicIdx    = colMap.get(cfg.Topic_Area_Field_API_Name__c);

            if (hybridIdx == null || answerIdx == null) return new List<Q_A_Answer__c>();

            List<AnswerCandidate> candidates = new List<AnswerCandidate>();

            for (ConnectApi.CdpQueryV2Row row : output.data) {
                List<Object> cols = row.rowData;

                Decimal hybridScore = Decimal.valueOf((String) cols[hybridIdx]).setScale(2);
                if (hybridScore < 0.60) continue;

                Q_A_Answer__c ans = new Q_A_Answer__c();
                ans.Q_A_Question__c        = questionId;
                ans.Answer__c              = (String) cols[answerIdx];
                ans.Match_Score__c         = hybridScore;
                ans.D360_Data_Source_ID__c = questionIdx != null ? (String) cols[questionIdx] : null;

                if (vectorIdx   != null && cols[vectorIdx]   != null) ans.Vector_Score__c   = Decimal.valueOf((String) cols[vectorIdx]).setScale(2);
                if (dateIdx     != null && cols[dateIdx]     != null) ans.Effective_Period__c = String.valueOf(cols[dateIdx]);
                if (companyIdx  != null && cols[companyIdx]  != null) ans.Company__c          = String.valueOf(cols[companyIdx]);
                if (firmIdx     != null && cols[firmIdx]     != null) ans.Consulting_Firm__c  = String.valueOf(cols[firmIdx]);
                if (rfpIdx      != null && cols[rfpIdx]      != null) ans.RFP_Name__c         = String.valueOf(cols[rfpIdx]);
                if (industryIdx != null && cols[industryIdx] != null) ans.Industry__c         = String.valueOf(cols[industryIdx]);
                if (svpIdx      != null && cols[svpIdx]      != null) ans.SVP_Name__c         = String.valueOf(cols[svpIdx]);
                if (topicIdx    != null && cols[topicIdx]    != null) ans.Topic_Area__c       = String.valueOf(cols[topicIdx]);

                // Apex-level post-filter: if the DC prefilter didn't narrow the corpus
                // (e.g. template issue), ensure only matching records are returned.
                if (String.isNotBlank(filterCompany)        && ans.Company__c        != null && ans.Company__c        != filterCompany)        continue;
                if (String.isNotBlank(filterConsultingFirm) && ans.Consulting_Firm__c != null && ans.Consulting_Firm__c != filterConsultingFirm) continue;
                if (String.isNotBlank(filterIndustry)       && ans.Industry__c       != null && ans.Industry__c       != filterIndustry)        continue;
                if (String.isNotBlank(filterRfpName)        && ans.RFP_Name__c       != null && ans.RFP_Name__c       != filterRfpName)         continue;
                if (String.isNotBlank(filterSvpName)        && ans.SVP_Name__c       != null && ans.SVP_Name__c       != filterSvpName)         continue;
                if (String.isNotBlank(filterTopicArea)      && ans.Topic_Area__c     != null && ans.Topic_Area__c     != filterTopicArea)       continue;

                candidates.add(new AnswerCandidate(ans, false));
            }

            candidates.sort();

            List<Q_A_Answer__c> result = new List<Q_A_Answer__c>();
            Set<String> seenAnswers = new Set<String>();
            for (AnswerCandidate c : candidates) {
                if (result.size() >= 3) break;
                String answerKey = c.rec.Answer__c != null ? c.rec.Answer__c.left(200).normalizeSpace() : '';
                if (seenAnswers.contains(answerKey)) continue;
                seenAnswers.add(answerKey);
                result.add(c.rec);
            }

            // LLM relevance check — same validation applied in the batch flow.
            // Results are display-only (no DML) so we filter in-memory.
            if (!result.isEmpty()) {
                List<String> matchQs = new List<String>();
                for (Q_A_Answer__c a : result) {
                    String qt = a.D360_Data_Source_ID__c;
                    if (String.isBlank(qt)) {
                        qt = String.isNotBlank(a.Answer__c) ? a.Answer__c.left(500) : '';
                    }
                    matchQs.add(qt);
                }
                for (Q_A_Answer__c a : result) a.Is_Relevant__c = true;
                String relevanceJson = QnaAIActionsController.checkMatchRelevanceByText(questionText, matchQs);
                if (String.isNotBlank(relevanceJson)) {
                    Map<Integer, Integer> rankMap = setRelevanceFlags(result, relevanceJson);
                    List<RankedAnswer> relevant = new List<RankedAnswer>();
                    for (Integer i = 0; i < result.size(); i++) {
                        if (result[i].Is_Relevant__c) {
                            relevant.add(new RankedAnswer(result[i], rankMap.containsKey(i) ? rankMap.get(i) : result.size() + 1));
                        }
                    }
                    relevant.sort();
                    result = new List<Q_A_Answer__c>();
                    for (RankedAnswer ra : relevant) result.add(ra.rec);
                }
            }

            return result;

        } catch (AuraHandledException e) {
            throw e;
        } catch (Exception e) {
            throw new AuraHandledException(e.getMessage());
        }
    }

    /**
     * Re-runs the Data Cloud semantic search for a question.
     * Deletes old answers (handled inside fetchAndStoreAnswers), resets
     * status from Draft → New, and stamps rerun-tracking fields.
     * Returns the updated question record so the LWC can reflect the new status.
     */
    @AuraEnabled
    public static Q_A_Question__c rerunSearch(Id questionId) {
        try {
            Q_A_Question__c q = [
                SELECT Id, QAQuestion__c, Status__c, Rerun_Count__c,
                       Last_Rerun_By__c, Last_Rerun_Date__c
                FROM Q_A_Question__c
                WHERE Id = :questionId
                LIMIT 1
            ];

            // fetchAndStoreAnswers deletes existing answers and inserts new ones
            fetchAndStoreAnswers(questionId, q.QAQuestion__c);

            // Update tracking fields
            q.Rerun_Count__c     = (q.Rerun_Count__c == null ? 0 : q.Rerun_Count__c) + 1;
            q.Last_Rerun_By__c   = UserInfo.getUserId();
            q.Last_Rerun_Date__c = Datetime.now();
            if (q.Status__c == 'Draft' || q.Status__c == 'Completed') {
                q.Status__c      = 'New';
                q.Final_Answer__c = null;
                q.Is_Finalized__c = false;
            }
            update q;

            return q;
        } catch (AuraHandledException e) {
            throw e;
        } catch (Exception e) {
            throw new AuraHandledException(e.getMessage());
        }
    }

    // ── Relevance flagging ──────────────────────────────────────────────────

    // Returns a map of answer-list index → LLM rank (1 = best).
    // Input IDs are "1","2","3" so Integer.valueOf(id)-1 gives the 0-based index.
    private static Map<Integer, Integer> setRelevanceFlags(List<Q_A_Answer__c> answers, String rawJson) {
        Map<Integer, Integer> rankMap = new Map<Integer, Integer>();
        try {
            // Strip markdown code fences the LLM sometimes adds despite instructions
            String cleanJson = rawJson.trim();
            if (cleanJson.startsWith('`')) {
                Integer nl = cleanJson.indexOf('\n');
                if (nl >= 0) cleanJson = cleanJson.substring(nl + 1).trim();
                if (cleanJson.endsWith('`')) cleanJson = cleanJson.substringBeforeLast('`').trim();
            }
            Map<String, Object> parsed = (Map<String, Object>) JSON.deserializeUntyped(cleanJson);
            List<Object> results = (List<Object>) parsed.get('results');
            for (Integer i = 0; i < results.size(); i++) {
                Map<String, Object> entry = (Map<String, Object>) results[i];
                Integer answerIdx = i;
                if (entry.get('id') != null) {
                    try { answerIdx = Integer.valueOf(String.valueOf(entry.get('id'))) - 1; } catch (Exception ex) {}
                }
                if (answerIdx >= 0 && answerIdx < answers.size()) {
                    answers[answerIdx].Is_Relevant__c = (entry.get('relevant') == true);
                    if (entry.get('match_quality') != null) {
                        answers[answerIdx].Match_Quality__c = String.valueOf(entry.get('match_quality'));
                    }
                    if (entry.get('rank') != null) {
                        try { rankMap.put(answerIdx, Integer.valueOf(String.valueOf(entry.get('rank')))); } catch (Exception ex) {}
                    }
                }
            }
        } catch (Exception e) {
            System.debug('setRelevanceFlags parse failed: ' + e.getMessage());
        }
        // Deduplicate ranks: if LLM assigned the same rank to multiple candidates
        // (e.g. two identical candidates), increment until unique
        Set<Integer> usedRanks = new Set<Integer>();
        List<Integer> idxList = new List<Integer>(rankMap.keySet());
        idxList.sort();
        for (Integer idx : idxList) {
            Integer rank = rankMap.get(idx);
            while (usedRanks.contains(rank)) rank++;
            usedRanks.add(rank);
            rankMap.put(idx, rank);
        }
        return rankMap;
    }

    private static List<Q_A_Answer__c> sortByRank(List<Q_A_Answer__c> answers, Map<Integer, Integer> rankMap) {
        List<RankedAnswer> wrapped = new List<RankedAnswer>();
        for (Integer i = 0; i < answers.size(); i++) {
            wrapped.add(new RankedAnswer(answers[i], rankMap.containsKey(i) ? rankMap.get(i) : answers.size() + 1));
        }
        wrapped.sort();
        List<Q_A_Answer__c> sorted = new List<Q_A_Answer__c>();
        for (RankedAnswer ra : wrapped) sorted.add(ra.rec);
        return sorted;
    }

    private class RankedAnswer implements Comparable {
        Q_A_Answer__c rec;
        Integer rank;
        RankedAnswer(Q_A_Answer__c r, Integer rk) { rec = r; rank = rk; }
        public Integer compareTo(Object other) { return rank - ((RankedAnswer) other).rank; }
    }

    // ── Inner class for sorting ─────────────────────────────────────────────

    private class AnswerCandidate implements Comparable {
        Q_A_Answer__c rec;
        Boolean firmMatch;

        AnswerCandidate(Q_A_Answer__c r, Boolean fm) {
            rec       = r;
            firmMatch = fm;
        }

        public Integer compareTo(Object other) {
            AnswerCandidate o = (AnswerCandidate) other;

            // 1. Higher hybrid score first
            Decimal myScore = rec.Match_Score__c != null ? rec.Match_Score__c : 0;
            Decimal otScore = o.rec.Match_Score__c != null ? o.rec.Match_Score__c : 0;
            if (myScore != otScore) return myScore > otScore ? -1 : 1;

            // 2. Same consulting firm as the document's preferred firm first
            if (firmMatch != o.firmMatch) return firmMatch ? -1 : 1;

            // 3. More recent effective date first (ISO string — lexicographic desc)
            String myDate = rec.Effective_Period__c != null ? rec.Effective_Period__c : '';
            String otDate = o.rec.Effective_Period__c != null ? o.rec.Effective_Period__c : '';
            if (myDate != otDate) return myDate > otDate ? -1 : 1;

            return 0;
        }
    }
}