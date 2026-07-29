/**
 * @description Invokes Salesforce Prompt Templates for the three AI editor actions
 *              in the Q&A Review Assistant: Apply Strategy, Edit with AI, and Style.
 * @author      Ambika & Nitheesh
 */
public with sharing class QnaAIActionsController {

    private static final String TEMPLATE_STRATEGY       = 'QA_Apply_Strategy';
    private static final String TEMPLATE_STRATEGY_CHECK = 'QA_Strategy_Applicability_Check';
    private static final String TEMPLATE_EDIT_AI        = 'QA_Edit_With_AI';
    private static final String TEMPLATE_STYLE          = 'QA_Style_Guide';

    // ── Edit with AI ─────────────────────────────────────────────────────────

    @AuraEnabled
    public static String editWithAI(Id questionId, String answer, String instructions) {
        if (String.isBlank(instructions)) {
            throw new AuraHandledException('Please enter instructions before proceeding.');
        }
        try {
            Q_A_Question__c q = [
                SELECT QAQuestion__c, Final_Answer__c
                FROM Q_A_Question__c
                WHERE Id = :questionId
                LIMIT 1
            ];
            String answerText = String.isNotBlank(answer) ? answer : q.Final_Answer__c;

            Map<String, ConnectApi.WrappedValue> inputs = new Map<String, ConnectApi.WrappedValue>();
            inputs.put('Input:Question',     wrap(q.QAQuestion__c));
            inputs.put('Input:Answer',       wrap(answerText));
            inputs.put('Input:Instructions', wrap(instructions));
            return invoke(TEMPLATE_EDIT_AI, inputs);
        } catch (AuraHandledException e) {
            throw e;
        } catch (Exception e) {
            throw new AuraHandledException('Edit with AI failed: ' + e.getMessage());
        }
    }

    // ── Style Answer ─────────────────────────────────────────────────────────

    @AuraEnabled
    public static String styleAnswer(Id questionId, String answer) {
        try {
            Q_A_Question__c q = [
                SELECT QAQuestion__c, Final_Answer__c
                FROM Q_A_Question__c
                WHERE Id = :questionId
                LIMIT 1
            ];
            String answerText = String.isNotBlank(answer) ? answer : q.Final_Answer__c;

            Map<String, ConnectApi.WrappedValue> inputs = new Map<String, ConnectApi.WrappedValue>();
            inputs.put('Input:Question', wrap(q.QAQuestion__c));
            inputs.put('Input:Answer',   wrap(answerText));
            return invoke(TEMPLATE_STYLE, inputs);
        } catch (Exception e) {
            throw new AuraHandledException('Style answer failed: ' + e.getMessage());
        }
    }

    // ── Shared helpers ───────────────────────────────────────────────────────

    private static String invoke(String templateName, Map<String, ConnectApi.WrappedValue> inputs) {
        ConnectApi.EinsteinPromptTemplateGenerationsInput config =
            new ConnectApi.EinsteinPromptTemplateGenerationsInput();
        config.additionalConfig = new ConnectApi.EinsteinLlmAdditionalConfigInput();
        config.isPreview = false;
        config.inputParams = inputs;

        ConnectApi.EinsteinPromptTemplateGenerationsRepresentation output =
            ConnectApi.EinsteinLLM.generateMessagesForPromptTemplate(templateName, config);

        if (output == null || output.generations == null || output.generations.isEmpty()) {
            throw new AuraHandledException('No response returned from prompt template: ' + templateName);
        }
        return output.generations[0].text;
    }

    // Calls QA_Strategy_Applicability_Check to decide whether strategy is
    // relevant for this question/answer pair.
    // Returns JSON: {"applicable":true} or {"applicable":false,"reason":"..."}
    @AuraEnabled
    public static String assessStrategyApplicability(Id questionId, String answer) {
        try {
            Q_A_Question__c q = [
                SELECT QAQuestion__c, Final_Answer__c
                FROM Q_A_Question__c
                WHERE Id = :questionId
                LIMIT 1
            ];
            String answerText = String.isNotBlank(answer) ? answer : q.Final_Answer__c;

            Map<String, ConnectApi.WrappedValue> inputs = new Map<String, ConnectApi.WrappedValue>();
            inputs.put('Input:Question', wrap(q.QAQuestion__c));
            inputs.put('Input:Answer',   wrap(answerText != null ? answerText : ''));
            return invoke(TEMPLATE_STRATEGY_CHECK, inputs);
        } catch (AuraHandledException e) {
            throw e;
        } catch (Exception e) {
            throw new AuraHandledException('Strategy assessment failed: ' + e.getMessage());
        }
    }

    @AuraEnabled
    public static String applyStrategy(Id questionId, String answer) {
        try {
            Q_A_Question__c q = [
                SELECT Id, QAQuestion__c,
                       Q_A_Document__r.Membership_Activity__c,
                       Q_A_Document__r.Company__r.Id,
                       Q_A_Document__r.Company__r.BusinessPressures__c,
                       Q_A_Document__r.Company__r.PotentialCompellingEvent__c,
                       Q_A_Document__r.Company__r.OurPotentialUniqueBusinessValue__c,
                       Q_A_Document__r.Company__r.KeyRiskstoourUBV__c,
                       Q_A_Document__r.Company__r.OutcomeDrivers__c,
                       Q_A_Document__r.Company__r.ApproachStrategy__c
                FROM Q_A_Question__c
                WHERE Id = :questionId
                LIMIT 1
            ];

            Account company = q.Q_A_Document__r?.Company__r;
            if (company == null) {
                throw new AuraHandledException('No Company is linked to this question\'s Q&A Document.');
            }

            String ctx = buildStrategyContext(company);
            if (String.isBlank(ctx)) {
                throw new AuraHandledException('The linked Company has no strategy details filled in.');
            }

            // Resolve the Membership Activity - direct link first, then fall back to
            // the Company so documents uploaded without an MA still work.
            Id maId = q.Q_A_Document__r?.Membership_Activity__c;
            if (maId == null) {
                maId = resolveMAFromCompany(company.Id);
            }

            String strategyPoints = '';
            if (maId != null) {
                strategyPoints = fetchStrategyPoints(maId);
                // No published points yet - generate them now using the same prompt
                // (Strategic_Points_Generation_Prompt) used by the Smart Analyzer.
                if (String.isBlank(strategyPoints)) {
                    strategyPoints = generateAndSaveStrategyPoints(maId);
                }
            }

            return invokeApplyStrategyTemplate(ctx, strategyPoints, q.QAQuestion__c, answer);

        } catch (AuraHandledException e) {
            throw e;
        } catch (Exception e) {
            throw new AuraHandledException('Apply Strategy failed: ' + e.getMessage());
        }
    }

    private static String fetchStrategyPoints(Id membershipActivityId) {
        List<Strategy_Point_Set__c> sets = [
            SELECT Id
            FROM Strategy_Point_Set__c
            WHERE Strategy_Memo__r.Membership_Activity__c = :membershipActivityId
              AND Is_Latest__c = true
              AND Status__c    = 'Published'
            ORDER BY Run_Date_Time__c DESC
            LIMIT 1
        ];
        if (sets.isEmpty()) return '';

        List<Strategy_Point__c> points = [
            SELECT Name, Original_Content__c, Content__c, Source_Reference__c
            FROM Strategy_Point__c
            WHERE Strategy_Point_Set__c = :sets[0].Id
            ORDER BY Name ASC
        ];
        if (points.isEmpty()) return '';

        List<String> lines = new List<String>();
        for (Strategy_Point__c sp : points) {
            String content = String.isNotBlank(sp.Content__c) ? sp.Content__c : sp.Original_Content__c;
            String line = sp.Name + ': ' + content;
            if (String.isNotBlank(sp.Source_Reference__c)) {
                line += ' (Derived from: ' + sp.Source_Reference__c + ')';
            }
            lines.add(line);
        }
        return String.join(lines, '\n');
    }

    // When the Q&A Document was uploaded under a Company without selecting a specific
    // Membership Activity, we pick the MA whose strategy points are most recent.
    // Falls back to any MA that has a Strategy Memo if none have published points yet.
    private static Id resolveMAFromCompany(Id companyId) {
        // Prefer the MA with the most recently published Strategy Point Set
        List<Strategy_Point_Set__c> sets = [
            SELECT Strategy_Memo__r.Membership_Activity__c
            FROM Strategy_Point_Set__c
            WHERE Strategy_Memo__r.Membership_Activity__r.AccountId = :companyId
              AND Is_Latest__c = true
              AND Status__c    = 'Published'
            ORDER BY Run_Date_Time__c DESC NULLS LAST
            LIMIT 1
        ];
        if (!sets.isEmpty()) {
            return sets[0].Strategy_Memo__r.Membership_Activity__c;
        }
        // No published points - fall back to any MA that has a Strategy Memo
        List<Strategy_Memo__c> memos = [
            SELECT Membership_Activity__c
            FROM Strategy_Memo__c
            WHERE Membership_Activity__r.AccountId = :companyId
            ORDER BY LastModifiedDate DESC
            LIMIT 1
        ];
        return memos.isEmpty() ? null : memos[0].Membership_Activity__c;
    }

    // Called when no published Strategy Point Set exists for the MA.
    // Mirrors StrategyMemoController.generateStrategyPointsPreview + saveStrategyPoints:
    //   1. Calls Strategic_Points_Generation_Prompt via SA_StrategyUtils (same as Smart Analyzer)
    //   2. Parses the response into Strategy_Point__c records
    //   3. Saves a new Published Strategy_Point_Set__c + the points
    //   4. Returns the formatted SP1/SP2/... string ready for the prompt
    private static String generateAndSaveStrategyPoints(Id membershipActivityId) {
        List<Strategy_Memo__c> memos = [
            SELECT Id
            FROM Strategy_Memo__c
            WHERE Membership_Activity__c = :membershipActivityId
            ORDER BY LastModifiedDate DESC
            LIMIT 1
        ];
        if (memos.isEmpty()) return '';

        Id memoId = memos[0].Id;

        // Demote any existing Is_Latest__c sets before creating the new one
        List<Strategy_Point_Set__c> existingLatest = [
            SELECT Id FROM Strategy_Point_Set__c
            WHERE Strategy_Memo__c = :memoId AND Is_Latest__c = true
        ];
        for (Strategy_Point_Set__c s : existingLatest) {
            s.Is_Latest__c = false;
            s.Status__c    = 'Superseded';
        }
        if (!existingLatest.isEmpty()) update existingLatest;

        // Call the same prompt used by the Smart Analyzer
        Map<String, String> promptInput = new Map<String, String>{
            'Input:Strategy_Memo' => String.valueOf(memoId)
        };
        String rawResponse = SA_StrategyUtils.processRecordWithRetries(
            promptInput, 'Strategic_Points_Generation_Prompt'
        );
        if (String.isBlank(rawResponse)) return '';

        List<Strategy_Point__c> points =
            SA_StrategyProcessor.parseStrategyPointsFromResponse(rawResponse, memoId);
        if (points.isEmpty()) return '';

        // Persist the new set and points
        Strategy_Point_Set__c newSet = new Strategy_Point_Set__c(
            Strategy_Memo__c = memoId,
            Status__c        = 'Published',
            Is_Latest__c     = true,
            Triggered_By__c  = UserInfo.getUserId(),
            AI_Response__c   = rawResponse.left(32768)
        );
        insert newSet;

        for (Strategy_Point__c p : points) {
            p.Strategy_Point_Set__c = newSet.Id;
        }
        insert points;

        // Re-query to get the auto-assigned Name (autonumber) on each point
        List<Strategy_Point__c> saved = [
            SELECT Name, Original_Content__c, Content__c, Source_Reference__c
            FROM Strategy_Point__c
            WHERE Strategy_Point_Set__c = :newSet.Id
            ORDER BY Name ASC
        ];

        List<String> lines = new List<String>();
        for (Strategy_Point__c sp : saved) {
            String content = String.isNotBlank(sp.Content__c) ? sp.Content__c : sp.Original_Content__c;
            String line = sp.Name + ': ' + content;
            if (String.isNotBlank(sp.Source_Reference__c)) {
                line += ' (Derived from: ' + sp.Source_Reference__c + ')';
            }
            lines.add(line);
        }
        return String.join(lines, '\n');
    }

    private static String buildStrategyContext(Account c) {
        List<String> parts = new List<String>();
        addPart(parts, 'Business Pressures',                   c.BusinessPressures__c);
        addPart(parts, 'Potential Compelling Event',           c.PotentialCompellingEvent__c);
        addPart(parts, 'Our Potential Unique Business Value',  c.OurPotentialUniqueBusinessValue__c);
        addPart(parts, 'Key Risks to our UBV',                 c.KeyRiskstoourUBV__c);
        addPart(parts, 'Outcome Drivers',                      c.OutcomeDrivers__c);
        addPart(parts, 'Approach Strategy',                    c.ApproachStrategy__c);
        return String.join(parts, '\n\n');
    }

    private static void addPart(List<String> parts, String label, String value) {
        if (String.isNotBlank(value)) {
            parts.add(label + ':\n' + value.trim());
        }
    }

    private static String invokeApplyStrategyTemplate(
        String strategyContext, String strategyPoints, String question, String answer
    ) {
        ConnectApi.EinsteinPromptTemplateGenerationsInput input =
            new ConnectApi.EinsteinPromptTemplateGenerationsInput();

        Map<String, ConnectApi.WrappedValue> params = new Map<String, ConnectApi.WrappedValue>();
        params.put('Input:StrategyContext', wrap(strategyContext));
        params.put('Input:StrategyPoints',  wrap(strategyPoints));
        params.put('Input:Question',        wrap(question));
        params.put('Input:Answer',          wrap(answer));

        input.inputParams = params;
        input.additionalConfig = new ConnectApi.EinsteinLlmAdditionalConfigInput();
        input.additionalConfig.applicationName = 'PromptBuilderPreview';
        input.isPreview = false;

        ConnectApi.EinsteinPromptTemplateGenerationsRepresentation res =
            ConnectApi.EinsteinLLM.generateMessagesForPromptTemplate('QA_Apply_Strategy', input);

        return res.generations[0].text;
    }

    private static ConnectApi.WrappedValue wrap(String val) {
        ConnectApi.WrappedValue w = new ConnectApi.WrappedValue();
        w.value = (val == null ? '' : val);
        return w;
    }
    private static final Map<String, String> ACTION_FLAGS = new Map<String, String>{
        'edit'     => 'Further_edited__c',
        'style'    => 'IsStyled__c',
        'strategy' => 'Strategy_Applied__c'
    };

    @AuraEnabled
    public static void markActionApplied(Id questionId, String action) {
        if (questionId == null) return;
        String field = ACTION_FLAGS.get(action);
        if (field == null) return;

        Q_A_Question__c rec = new Q_A_Question__c(Id = questionId);
        rec.put(field, true);
        update rec;
    }
    
}