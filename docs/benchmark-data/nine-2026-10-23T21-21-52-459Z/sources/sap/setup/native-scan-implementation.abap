  METHOD scan_native.
    TYPES: BEGIN OF ty_native_row,
      orderid TYPE string,
      positionnumber TYPE string,
      customerid TYPE string,
      orderdate TYPE string,
      materialid TYPE string,
      quantity TYPE string,
      unit TYPE string,
      netamount TYPE string,
      currency TYPE string,
    END OF ty_native_row.
    DATA batch TYPE STANDARD TABLE OF ty_native_row WITH EMPTY KEY.
    DATA cursor TYPE REF TO cl_sql_result_set.
    settings = config.
    CLEAR: current_result, previous_order, previous_position, client, nodes.
    current_result-schema_version = 1.
    current_result-scan_index = scan_index.
    timer = NEW lcl_bl_clock( ).
    started = timer->now( ).
    TRY.
        config_check( direct = abap_true ).
        IF sy-mandt <> '001'.
          fail( 'CONFIG' ).
        ENDIF.
        digest = cl_abap_message_digest=>get_instance( 'SHA-256' ).
        digest->update( cl_abap_message_digest=>string_to_xstring(
          |sap-polling-lab{ cl_abap_char_utilities=>horizontal_tab }1{ cl_abap_char_utilities=>newline }| ) ).
        deadline( ).
        DATA(statement) = NEW cl_sql_statement( ).
        cursor = statement->execute_query(
          `SELECT "ORDERID", "POSITIONNUMBER", "CUSTOMERID", "ORDERDATE", ` &&
          `"MATERIALID", "QUANTITY", "UNIT", "NETAMOUNT", "CURRENCY" ` &&
          `FROM "ZBL_BENCH_SQL"."ORDER_POSITIONS_001" ` &&
          `ORDER BY "ORDERID", "POSITIONNUMBER"` ).
        cursor->set_param_table( itab_ref = REF #( batch ) ).
        DO.
          deadline( ).
          CLEAR batch.
          current_result-error-page_index = current_result-pages + 1.
          IF current_result-pages >= settings-max_pages. fail( 'LIMIT' ). ENDIF.
          current_result-pages += 1.
          DATA(fetched) = cursor->next_package( upto = 100 ).
          deadline( ).
          LOOP AT batch INTO DATA(row).
            deadline( ).
            validate_values( VALUE string_table(
              ( row-orderid ) ( row-positionnumber ) ( row-customerid )
              ( row-orderdate ) ( row-materialid ) ( row-quantity )
              ( row-unit ) ( row-netamount ) ( row-currency ) ) ).
          ENDLOOP.
          IF fetched < 100. EXIT. ENDIF.
        ENDDO.
        cursor->close( ).
        CLEAR cursor.
        deadline( ).
        IF current_result-rows <> settings-expected_rows. fail( 'COUNT' ). ENDIF.
        DATA hash TYPE string.
        digest->digest( IMPORTING ef_hashstring = hash ).
        TRANSLATE hash TO LOWER CASE.
        deadline( ).
        IF hash <> settings-expected_digest. fail( 'DIGEST' ). ENDIF.
        current_result-digest = hash.
        current_result-outcome = 'ok'.
        CLEAR current_result-error.
      CATCH lcx_bl_poll INTO DATA(error).
        current_result-outcome = 'error'.
        current_result-error-code = error->code.
      CATCH cx_sql_exception INTO DATA(sql_error).
        current_result-outcome = 'error'.
        current_result-error-code = COND #(
          WHEN sql_error->sql_code = 613 OR timer->now( ) - started
            >= CONV int8( settings-scan_timeout_seconds ) * 1000000
          THEN 'TIMEOUT' ELSE 'TRANSPORT' ).
      CATCH cx_root.
        current_result-outcome = 'error'.
        current_result-error-code = 'SCHEMA'.
    ENDTRY.
    IF cursor IS BOUND.
      TRY.
          cursor->close( ).
        CATCH cx_sql_exception.
          " Preserve the original scan error if cursor cleanup also fails.
      ENDTRY.
    ENDIF.
    current_result-elapsed_ms = ( timer->now( ) - started ) DIV 1000.
    result = current_result.
  ENDMETHOD.