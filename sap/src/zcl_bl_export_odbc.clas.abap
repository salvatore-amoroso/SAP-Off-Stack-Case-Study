CLASS zcl_bl_export_odbc DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES if_oo_adt_classrun.
ENDCLASS.

CLASS zcl_bl_export_odbc IMPLEMENTATION.
  METHOD if_oo_adt_classrun~main.
    DATA lv_package TYPE devclass VALUE '$ZBACKEND_LAB'.
    DATA lv_zip_class TYPE string VALUE '\PROGRAM=ZABAPGIT_STANDALONE\CLASS=ZCL_ABAPGIT_ZIP'.
    DATA lv_dot_class TYPE string VALUE '\PROGRAM=ZABAPGIT_STANDALONE\CLASS=ZCL_ABAPGIT_DOT_ABAPGIT'.
    DATA lv_serializer_class TYPE string VALUE '\PROGRAM=ZABAPGIT_STANDALONE\CLASS=ZCL_ABAPGIT_SERIALIZE'.
    DATA lv_log_class TYPE string VALUE '\PROGRAM=ZABAPGIT_STANDALONE\CLASS=ZCL_ABAPGIT_LOG'.
    DATA lr_settings TYPE REF TO data.
    DATA lr_dot TYPE REF TO data.
    DATA lr_log TYPE REF TO data.
    DATA lr_files TYPE REF TO data.
    DATA lr_messages TYPE REF TO data.
    DATA lr_filter TYPE REF TO data.
    DATA lr_filter_line TYPE REF TO data.
    DATA lo_serializer TYPE REF TO object.
    DATA lo_log TYPE REF TO object.
    DATA lv_status TYPE symsgty.
    DATA lv_zip TYPE xstring.
    DATA lv_base64 TYPE string.
    DATA lv_offset TYPE i.
    DATA lv_length TYPE i.
    DATA lv_chunk TYPE string.
    FIELD-SYMBOLS <settings> TYPE any.
    FIELD-SYMBOLS <flag> TYPE any.
    FIELD-SYMBOLS <dot> TYPE any.
    FIELD-SYMBOLS <log> TYPE any.
    FIELD-SYMBOLS <files> TYPE ANY TABLE.
    FIELD-SYMBOLS <messages> TYPE ANY TABLE.
    FIELD-SYMBOLS <filter> TYPE ANY TABLE.
    FIELD-SYMBOLS <filter_line> TYPE any.
    FIELD-SYMBOLS <component> TYPE any.

    TRY.
        DATA(lo_zip_descr) = CAST cl_abap_classdescr( cl_abap_typedescr=>describe_by_name( lv_zip_class ) ).
        DATA(lo_serializer_descr) = CAST cl_abap_classdescr( cl_abap_typedescr=>describe_by_name( lv_serializer_class ) ).
        DATA(lo_settings_type) = lo_zip_descr->get_method_parameter_type( p_method_name = 'EXPORT' p_parameter_name = 'IS_LOCAL_SETTINGS' ).
        DATA(lo_dot_type) = lo_zip_descr->get_method_parameter_type( p_method_name = 'EXPORT' p_parameter_name = 'IO_DOT_ABAPGIT' ).
        DATA(lo_log_type) = lo_serializer_descr->get_method_parameter_type( p_method_name = 'FILES_LOCAL' p_parameter_name = 'II_LOG' ).
        DATA(lo_files_type) = lo_serializer_descr->get_method_parameter_type( p_method_name = 'FILES_LOCAL' p_parameter_name = 'RT_FILES' ).
        CREATE DATA lr_settings TYPE HANDLE lo_settings_type.
        CREATE DATA lr_dot TYPE HANDLE lo_dot_type.
        CREATE DATA lr_log TYPE HANDLE lo_log_type.
        CREATE DATA lr_files TYPE HANDLE lo_files_type.
        ASSIGN lr_settings->* TO <settings>.
        ASSIGN lr_dot->* TO <dot>.
        ASSIGN lr_log->* TO <log>.
        ASSIGN lr_files->* TO <files>.
        ASSIGN COMPONENT 'MAIN_LANGUAGE_ONLY' OF STRUCTURE <settings> TO <flag>.
        <flag> = abap_true.
        ASSIGN COMPONENT 'IGNORE_SUBPACKAGES' OF STRUCTURE <settings> TO <flag>.
        <flag> = abap_true.

        CALL METHOD (lv_dot_class)=>('BUILD_DEFAULT') RECEIVING ro_dot_abapgit = <dot>.
        CREATE OBJECT <log> TYPE (lv_log_class).
        lo_log = <log>.
        CREATE OBJECT lo_serializer TYPE (lv_serializer_class)
          EXPORTING io_dot_abapgit = <dot> is_local_settings = <settings>.
        " Installed abapGit does not support generated SQL1 runtime objects.
        " Keep the real SRVB binding and generated SUSH authorization defaults;
        " explicitly exclude SQL1 and preserve separate ADT provisioning proof.
        DATA(lo_filter_type) = lo_serializer_descr->get_method_parameter_type( p_method_name = 'FILES_LOCAL' p_parameter_name = 'IT_FILTER' ).
        CREATE DATA lr_filter TYPE HANDLE lo_filter_type.
        ASSIGN lr_filter->* TO <filter>.
        DATA(lo_line_type) = CAST cl_abap_tabledescr( lo_filter_type )->get_table_line_type( ).
        CREATE DATA lr_filter_line TYPE HANDLE lo_line_type.
        ASSIGN lr_filter_line->* TO <filter_line>.
        SELECT object, obj_name, devclass FROM tadir
          WHERE pgmid = 'R3TR' AND devclass = @lv_package AND object <> 'SQL1'
          INTO TABLE @DATA(objects).
        LOOP AT objects INTO DATA(object).
          CLEAR <filter_line>.
          ASSIGN COMPONENT 'OBJECT' OF STRUCTURE <filter_line> TO <component>.
          <component> = object-object.
          ASSIGN COMPONENT 'OBJ_NAME' OF STRUCTURE <filter_line> TO <component>.
          <component> = object-obj_name.
          ASSIGN COMPONENT 'DEVCLASS' OF STRUCTURE <filter_line> TO <component>.
          <component> = object-devclass.
          INSERT <filter_line> INTO TABLE <filter>.
        ENDLOOP.
        out->write( 'EXCLUDED_GENERATED_TYPE SQL1' ).
        CALL METHOD lo_serializer->('FILES_LOCAL')
          EXPORTING iv_package = lv_package ii_log = <log> it_filter = <filter>
          RECEIVING rt_files = <files>.
        CALL METHOD lo_log->('ZIF_ABAPGIT_LOG~GET_STATUS') RECEIVING rv_status = lv_status.

        out->write( |PACKAGE { lv_package }| ).
        out->write( |FILES { lines( <files> ) }| ).
        out->write( |LOG_STATUS { lv_status }| ).
        IF lv_status = 'E' OR lv_status = 'W'.
          DATA(lo_log_descr) = CAST cl_abap_classdescr( cl_abap_typedescr=>describe_by_name( lv_log_class ) ).
          DATA(lo_messages_type) = lo_log_descr->get_method_parameter_type( p_method_name = 'ZIF_ABAPGIT_LOG~GET_MESSAGES' p_parameter_name = 'RT_MSG' ).
          CREATE DATA lr_messages TYPE HANDLE lo_messages_type.
          ASSIGN lr_messages->* TO <messages>.
          CALL METHOD lo_log->('ZIF_ABAPGIT_LOG~GET_MESSAGES') RECEIVING rt_msg = <messages>.
          out->write( <messages> ).
          IF lv_status = 'E'.
            RETURN.
          ENDIF.
        ENDIF.

        CALL METHOD (lv_zip_class)=>('ENCODE_FILES') EXPORTING it_files = <files> RECEIVING rv_xstr = lv_zip.
        lv_base64 = cl_http_utility=>encode_x_base64( lv_zip ).
        out->write( |ZIP_BYTES { xstrlen( lv_zip ) }| ).
        out->write( 'ZIP_BASE64_BEGIN' ).
        WHILE lv_offset < strlen( lv_base64 ).
          lv_length = nmin( val1 = 200 val2 = strlen( lv_base64 ) - lv_offset ).
          lv_chunk = lv_base64+lv_offset(lv_length).
          out->write( lv_chunk ).
          lv_offset = lv_offset + lv_length.
        ENDWHILE.
        out->write( 'ZIP_BASE64_END' ).
      CATCH cx_root INTO DATA(lx_error).
        out->write( |EXPORT_ERROR { lx_error->get_text( ) }| ).
    ENDTRY.
  ENDMETHOD.
ENDCLASS.


